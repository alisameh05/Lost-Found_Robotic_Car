#include <Arduino.h>
#include <avr/interrupt.h>
#include <avr/wdt.h>

#include "proximity.h"
#include "selected_build.h"

#if LAF_PROXIMITY
namespace {
constexpr uint8_t Trigger = 12, Echo = 13;
constexpr uint32_t EchoTimeoutUs = 30000;
enum Edge : uint8_t { Idle, Rising, Falling, Complete };
volatile Edge edge = Idle;
volatile uint32_t rise, fall;
uint32_t startedUs, startedMs, acquiredMs, sequence, reported;
uint16_t distanceMm;
}

ISR(PCINT0_vect) {
    const bool high = PINB & _BV(PB5);  // Uno D13.
    if (edge == Rising && high) {
        rise = micros();
        edge = Falling;
    } else if (edge == Falling && !high) {
        fall = micros();
        edge = Complete;
    }
}

namespace uno {
namespace proximity {
void begin() {
    digitalWrite(Trigger, LOW);
    pinMode(Trigger, OUTPUT);
    pinMode(Echo, INPUT);
    PCIFR = _BV(PCIF0);
    PCMSK0 |= _BV(PCINT5);
    PCICR |= _BV(PCIE0);
}

void tick() {
    const Edge current = edge;
    const uint32_t nowUs = micros();
    if (current != Idle) {
        const bool timedOut = nowUs - startedUs >= EchoTimeoutUs;
        if (current != Complete && !timedOut) return;
        uint32_t duration = 0;
        if (current == Complete && fall - startedUs <= EchoTimeoutUs) duration = fall - rise;
        edge = Idle;
        acquiredMs = startedMs;
        distanceMm = static_cast<uint16_t>((duration * 343UL + 1000UL) / 2000UL);
        if (sequence != UINT32_MAX) ++sequence;
        return;
    }
    const uint32_t nowMs = millis();
    if (sequence == UINT32_MAX || nowMs - startedMs < ProximityIntervalMs) return;
    startedUs = nowUs;
    startedMs = nowMs;
    edge = Rising;
    digitalWrite(Trigger, HIGH);
    delayMicroseconds(10);
    digitalWrite(Trigger, LOW);
}

bool take(uint32_t now, ProximitySample &sample) {
    if (sequence == reported || now - acquiredMs >= UINT16_MAX) return false;
    reported = sequence;
    sample = {sequence, static_cast<uint16_t>(now - acquiredMs + 1), distanceMm};
    return true;
}
}
}
#endif
