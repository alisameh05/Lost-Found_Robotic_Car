#pragma once

#include <stddef.h>
#include <stdint.h>

namespace uno {
namespace port {
constexpr int Empty = -1;
constexpr int Fault = -2;
void begin();
int read();
void reply(const uint8_t *data, size_t length);
}
}
