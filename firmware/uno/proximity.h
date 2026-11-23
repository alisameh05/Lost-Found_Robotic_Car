#pragma once

#include "command.h"

namespace uno {
namespace proximity {
void begin();
void tick();
bool take(uint32_t now, ProximitySample &sample);
}
}
