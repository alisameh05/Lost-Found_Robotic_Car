#pragma once

#include <stddef.h>
#include <stdint.h>

namespace uno {
enum Op : uint8_t { Hello = 1, Status, Arm, Drive, Stop };
constexpr uint8_t Version = 1, Reply = 0x80, Armed = 1;
constexpr size_t Payload = 24, Request = Payload + 2, MaxFrame = 60;

struct Timing {
    uint16_t packet_ms;
    uint16_t challenge_ms;
    uint16_t expiry_ms;
};

using Output = void (*)(uint8_t direction);
using ReplyWriter = void (*)(const uint8_t *, size_t);

class Peer {
public:
    Peer(uint32_t boot, Timing timing, const uint8_t *build, Output output, ReplyWriter write);
    void tick(uint32_t now);
    void receive(uint8_t byte, uint32_t now);
    void transportFault();

private:
    void disable();
    void apply(uint32_t now);
    void acknowledge(uint8_t op, uint32_t sequence, uint32_t echo, uint32_t now);

    const uint32_t boot_;
    const Timing timing_;
    const uint8_t *const build_;
    const Output output_;
    const ReplyWriter write_;
    uint32_t generation_ = 0, sequence_ = 0, counter_ = 0;
    uint32_t challenge_at_ = 0, lease_at_ = 0, packet_at_ = 0;
    uint8_t frame_[MaxFrame - 1], raw_[Request];
    size_t length_ = 0;
    uint8_t direction_ = 0;
    bool armed_ = false, challenge_ = false, discarding_ = false;
};
}
