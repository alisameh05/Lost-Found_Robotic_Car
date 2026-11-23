#include "command.h"

#include <string.h>

namespace uno {
namespace {
uint16_t crc(const uint8_t *data, size_t size) {
    uint16_t value = 0xffff;
    for (size_t i = 0; i < size; ++i) {
        value ^= static_cast<uint16_t>(data[i]) << 8;
        for (uint8_t bit = 0; bit < 8; ++bit) {
            value = value & 0x8000 ? static_cast<uint16_t>((value << 1) ^ 0x1021) : value << 1;
        }
    }
    return value;
}

uint32_t get32(const uint8_t *data) {
    return static_cast<uint32_t>(data[0]) | static_cast<uint32_t>(data[1]) << 8 |
           static_cast<uint32_t>(data[2]) << 16 | static_cast<uint32_t>(data[3]) << 24;
}

void put32(uint8_t *data, uint32_t value) {
    for (uint8_t i = 0; i < 4; ++i) {
        data[i] = static_cast<uint8_t>(value >> (8 * i));
    }
}

void put16(uint8_t *data, uint16_t value) {
    data[0] = static_cast<uint8_t>(value);
    data[1] = static_cast<uint8_t>(value >> 8);
}

size_t unstuff(const uint8_t *frame, size_t length, uint8_t *raw) {
    size_t read = 0, count = 0;
    while (read < length) {
        uint8_t block = frame[read++];
        size_t end = read + block - 1;
        if (!block || end > length || count + block - (end == length) > Request) {
            return 0;
        }
        while (read < end) raw[count++] = frame[read++];
        if (read < length) raw[count++] = 0;
    }
    return count;
}

size_t stuff(const uint8_t *raw, size_t length, uint8_t *frame) {
    size_t code = 0, write = 1;
    for (size_t read = 0; read < length; ++read) {
        if (raw[read] == 0) {
            frame[code] = static_cast<uint8_t>(write - code);
            code = write++;
        } else {
            frame[write++] = raw[read];
        }
    }
    frame[code] = static_cast<uint8_t>(write - code);
    frame[write++] = 0;
    return write;
}
}

Peer::Peer(uint32_t boot, Timing timing, const uint8_t *build, Output output, ReplyWriter write,
           TakeProximity proximity)
    : boot_(boot), timing_(timing), build_(build), output_(output), write_(write), proximity_(proximity) {}

void Peer::disable() {
    armed_ = challenge_ = false;
    direction_ = 0;
    output_(0);
}

void Peer::transportFault() {
    length_ = 0;
    discarding_ = true;
    disable();
}

void Peer::tick(uint32_t now) {
    if (armed_ && now - lease_at_ >= timing_.expiry_ms) disable();
    if (challenge_ && now - challenge_at_ >= timing_.challenge_ms) challenge_ = false;
    if (length_ && now - packet_at_ >= timing_.packet_ms) {
        transportFault();
    }
}

void Peer::receive(uint8_t byte, uint32_t now) {
    tick(now);
    if (byte == 0) {
        if (length_) apply(now);
        length_ = 0;
        discarding_ = false;
    } else if (!discarding_) {
        if (!length_) packet_at_ = now;
        if (length_ >= Request + 1) {
            transportFault();
        } else {
            frame_[length_++] = byte;
        }
    }
}

void Peer::apply(uint32_t now) {
    if (unstuff(frame_, length_, raw_) != Request || raw_[0] != Version ||
        crc(raw_, Payload) != (static_cast<uint16_t>(raw_[Payload + 1]) << 8 | raw_[Payload]) ||
        get32(raw_ + 18) != 0 || raw_[23] != 0 || !boot_) {
        disable();
        return;
    }
    const uint8_t op = raw_[1], direction = raw_[22];
    const uint32_t boot = get32(raw_ + 2), generation = get32(raw_ + 6);
    const uint32_t sequence = get32(raw_ + 10), challenge = get32(raw_ + 14);
    if (op == Hello && !boot && !generation && sequence && !challenge && !direction) {
        disable();
        acknowledge(op, sequence, sequence_, now);
        return;
    }
    if (op == Stop && !direction) {
        disable();
        if (boot == boot_ && sequence > sequence_) {
            sequence_ = sequence;
            acknowledge(op, sequence, challenge, now);
        }
        return;
    }
    const bool status = op == Status && !generation && !direction && !armed_;
    const bool arm = op == Arm && !direction && !armed_ && generation > generation_;
    const bool drive = op == Drive && direction >= 1 && direction <= 4 && armed_ && generation == generation_;
    if (boot != boot_ || sequence <= sequence_ || !challenge_ || challenge != counter_ ||
        counter_ == UINT32_MAX || !(status || arm || drive)) {
        disable();
        return;
    }
    sequence_ = sequence;
    if (arm || drive) {
        generation_ = generation;
        armed_ = true;
        lease_at_ = now;
        if (direction_ != direction) {
            direction_ = direction;
            output_(direction);
        }
    }
    acknowledge(op, sequence, challenge, now);
}

void Peer::acknowledge(uint8_t op, uint32_t sequence, uint32_t echo, uint32_t now) {
    if (counter_ == UINT32_MAX) {
        disable();
        return;
    }
    challenge_at_ = now;
    challenge_ = true;
    uint8_t raw[Payload + 32 + 2] = {Version, static_cast<uint8_t>(op | Reply)};
    put32(raw + 2, boot_);
    put32(raw + 6, generation_);
    put32(raw + 10, sequence);
    put32(raw + 14, echo);
    put32(raw + 18, ++counter_);
    raw[22] = direction_;
    raw[23] = armed_ ? Armed : 0;
    size_t size = Payload;
    if (op == Hello) {
        memcpy(raw + size, build_, 32);
        size += 32;
    }
    const uint16_t integrity = crc(raw, size);
    raw[size++] = static_cast<uint8_t>(integrity);
    raw[size++] = static_cast<uint8_t>(integrity >> 8);
    uint8_t frame[MaxFrame];
    const size_t length = stuff(raw, size, frame);
    write_(frame, length);
    if (proximity_ && (op == Status || op == Drive)) reportProximity(now);
}

void Peer::reportProximity(uint32_t now) {
    ProximitySample sample{};
    if (!proximity_(now, sample)) return;
    constexpr uint8_t ProximityVersion = 1;
    uint8_t raw[20] = {ProximityVersion};
    put32(raw + 1, boot_);
    put32(raw + 5, counter_);
    put32(raw + 9, sample.sequence);
    put16(raw + 13, sample.age_ms);
    put16(raw + 15, sample.distance_mm);
    raw[17] = sample.distance_mm != 0;
    put16(raw + 18, crc(raw, 18));
    uint8_t frame[23] = {1};
    write_(frame, 1 + stuff(raw, sizeof(raw), frame + 1));
}
}
