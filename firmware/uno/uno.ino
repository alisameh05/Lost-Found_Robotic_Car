#include <Arduino.h>
#include <EEPROM.h>
#include <avr/wdt.h>

#include "command.h"
#include "command_port.h"
#include "selected_build.h"

namespace {
constexpr uint8_t Committed = 0xa5;
constexpr int RecordSize = 9;

// Publish a generation only after the other slot is committed. A reset during
// an EEPROM write cannot reuse a generation from a boot that accepted commands.
bool readGeneration(int address, uint32_t &generation) {
    generation = 0;
    if (EEPROM.read(address) != Committed) return true;
    uint32_t check;
    EEPROM.get(address + 1, generation);
    EEPROM.get(address + 5, check);
    return generation && check == ~generation;
}

uint32_t nextBoot() {
    uint32_t first, second;
    if (!readGeneration(0, first) || !readGeneration(RecordSize, second)) return 0;
    const uint32_t previous = first > second ? first : second;
    if (previous == UINT32_MAX) return 0;
    const int target = first <= second ? 0 : RecordSize;
    const uint32_t next = previous + 1;
    EEPROM.update(target, 0);
    EEPROM.put(target + 1, next);
    EEPROM.put(target + 5, ~next);
    EEPROM.update(target, Committed);
    uint32_t actual;
    return readGeneration(target, actual) && actual == next ? next : 0;
}

#if LAF_DEVICE_OUTPUT
void disableEnables() {
    for (uint8_t motor = 0; motor < 2; ++motor) {
        digitalWrite(EnablePins[motor], EnableHigh[motor] ? LOW : HIGH);
    }
}

void initializeOutput() {
    disableEnables();
    for (uint8_t pin : EnablePins) pinMode(pin, OUTPUT);
    for (uint8_t index = 0; index < 4; ++index) {
        digitalWrite(DirectionPins[index], Levels[0][index]);
        pinMode(DirectionPins[index], OUTPUT);
    }
}

void logicalOutput(uint8_t direction) {
    disableEnables();
    for (uint8_t index = 0; index < 4; ++index) {
        digitalWrite(DirectionPins[index], Levels[direction][index]);
    }
    if (direction) {
        for (uint8_t motor = 0; motor < 2; ++motor) {
            analogWrite(EnablePins[motor], EnableHigh[motor] ? Duty[direction][motor] : 255 - Duty[direction][motor]);
        }
    }
}
#else
void initializeOutput() {}
void logicalOutput(uint8_t) {}
#endif

uno::Peer *peer = nullptr;
}

void setup() {
    initializeOutput();
    logicalOutput(0);
    const uint32_t boot = nextBoot();
    uno::port::begin();
    static uno::Peer command(boot, Timings, BuildId, logicalOutput, uno::port::reply);
    peer = &command;
    wdt_enable(HardwareWatchdog);
}

void loop() {
    wdt_reset();
    peer->tick(millis());
    // Limit work even when the receive buffer is constantly full.
    for (uint8_t read = 0; read < 8; ++read) {
        const int byte = uno::port::read();
        if (byte == uno::port::Empty) break;
        if (byte == uno::port::Fault) {
            peer->transportFault();
            break;
        }
        peer->receive(static_cast<uint8_t>(byte), millis());
    }
}
