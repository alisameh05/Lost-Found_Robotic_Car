#include <Arduino.h>
#include <avr/wdt.h>

#include "command.h"
#include "command_port.h"
#include "selected_build.h"

#if LAF_HC05_PINS
#include <avr/interrupt.h>
#include <util/atomic.h>

namespace {
constexpr uint8_t BufferSize = 64, BufferMask = BufferSize - 1;
constexpr uint8_t RxMask = _BV(RxPin), TxMask = _BV(TxPin);
constexpr unsigned long Prescale = Baud < 19200 ? 32 : 8;
constexpr uint8_t BitTicks = (F_CPU / Prescale + Baud / 2) / Baud;
constexpr uint8_t TimerClock = Prescale == 32 ? _BV(CS21) | _BV(CS20) : _BV(CS21);
static_assert(Baud == 9600 || Baud == 19200 || Baud == 38400, "Unsupported HC-05 line rate");
static_assert(BitTicks >= 16 && BitTicks <= 127, "Bit interval must fit Timer2");
static_assert(BufferSize > uno::MaxFrame, "The port must buffer a complete reply");

volatile uint8_t rxBuffer[BufferSize], txBuffer[BufferSize];
volatile uint8_t rxHead = 0, rxTail = 0, txHead = 0, txTail = 0;
volatile bool transportFault = false;
uint8_t rxBit = 0, rxByte = 0, txBit = 0, txByte = 0;

void listenForStart() {
    TIMSK2 &= ~_BV(OCIE2A);
    PCIFR = _BV(PCIF2);
    PCMSK2 |= RxMask;
}
}

ISR(PCINT2_vect) {
    if (PIND & RxMask) return;
    PCMSK2 &= ~RxMask;
    rxBit = rxByte = 0;
    OCR2A = TCNT2 + BitTicks / 2;
    TIFR2 = _BV(OCF2A);
    TIMSK2 |= _BV(OCIE2A);
}

ISR(TIMER2_COMPA_vect) {
    OCR2A += BitTicks;
    const bool high = PIND & RxMask;
    if (rxBit == 0 && high) {
        transportFault = true;
        listenForStart();
    } else if (rxBit == 9) {
        if (!high || static_cast<uint8_t>(rxHead - rxTail) >= BufferSize) {
            transportFault = true;
        } else {
            rxBuffer[rxHead & BufferMask] = rxByte;
            ++rxHead;
        }
        listenForStart();
    } else {
        // Eight LSB-first samples fill the byte from the high end.
        if (rxBit) rxByte = (rxByte >> 1) | (high ? 0x80 : 0);
        ++rxBit;
    }
}

ISR(TIMER2_COMPB_vect) {
    OCR2B += BitTicks;
    if (txBit == 0) {
        if (txTail == txHead) {
            TIMSK2 &= ~_BV(OCIE2B);
            return;
        }
        txByte = txBuffer[txTail & BufferMask];
        ++txTail;
        PORTD &= ~TxMask;
    } else if (txBit == 9 || (txByte & 1)) {
        PORTD |= TxMask;
    } else {
        PORTD &= ~TxMask;
    }
    if (txBit == 9) {
        txBit = 0;
    } else {
        if (txBit) txByte >>= 1;
        ++txBit;
    }
}

namespace uno {
namespace port {
void begin() {
    // Timer2 owns only the Bluetooth UART. Timer0 still supplies millis().
    TIMSK2 = 0;
    TCCR2B = 0;
    TCCR2A = 0;
    TCNT2 = 0;
    TCCR2B = TimerClock;
    pinMode(RxPin, INPUT);
    digitalWrite(TxPin, HIGH);
    pinMode(TxPin, OUTPUT);
    listenForStart();
    PCICR |= _BV(PCIE2);
}

int read() {
    int value = Empty;
    ATOMIC_BLOCK(ATOMIC_RESTORESTATE) {
        if (transportFault) {
            transportFault = false;
            rxTail = rxHead;
            value = Fault;
        } else if (rxTail != rxHead) {
            value = rxBuffer[rxTail & BufferMask];
            ++rxTail;
        }
    }
    return value;
}

void reply(const uint8_t *data, size_t length) {
    uint8_t head = txHead;
    const uint8_t free = BufferSize - static_cast<uint8_t>(head - txTail);
    if (length > free) return;
    for (size_t i = 0; i < length; ++i) {
        txBuffer[head & BufferMask] = data[i];
        ++head;
    }
    ATOMIC_BLOCK(ATOMIC_RESTORESTATE) {
        txHead = head;
        if (!(TIMSK2 & _BV(OCIE2B))) {
            OCR2B = TCNT2 + BitTicks;
            TIFR2 = _BV(OCF2B);
            TIMSK2 |= _BV(OCIE2B);
        }
    }
}
}
}
#else
namespace uno {
namespace port {
void begin() { Serial.begin(Baud, SERIAL_8N1); }
int read() { return Serial.read(); }
void reply(const uint8_t *data, size_t length) {
    if (Serial.availableForWrite() >= static_cast<int>(length)) Serial.write(data, length);
}
}
}
#endif
