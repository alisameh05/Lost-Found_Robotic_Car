#include "command.h"

#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>

namespace {
uint8_t output = 0;
uint8_t build[32] = {0x90};
std::string reply;
uno::ProximitySample sample{};

bool takeProximity(uint32_t, uno::ProximitySample &next) {
    if (!sample.sequence) return false;
    next = sample;
    sample = {};
    return true;
}

void writeOutput(uint8_t direction) {
    output = direction;
}

void writeReply(const uint8_t *data, size_t length) {
    std::ostringstream hex;
    for (size_t i = 0; i < length; ++i) {
        hex << std::hex << std::setw(2) << std::setfill('0') << static_cast<unsigned>(data[i]);
    }
    reply += hex.str();
}
}

int main(int argc, char **argv) {
    if (argc != 4) return 1;
    const uno::Timing timing = {
        static_cast<uint16_t>(std::stoul(argv[1])),
        static_cast<uint16_t>(std::stoul(argv[2])),
        static_cast<uint16_t>(std::stoul(argv[3])),
    };
    uint32_t boot = 1;
    uno::Peer peer(boot, timing, build, writeOutput, writeReply, takeProximity);
    std::string line;
    while (std::getline(std::cin, line)) {
        std::istringstream command(line);
        uint32_t now;
        std::string input;
        command >> now >> input;
        reply.clear();
        if (input == "reset") {
            peer.~Peer();
            writeOutput(0);
            sample = {};
            new (&peer) uno::Peer(++boot, timing, build, writeOutput, writeReply, takeProximity);
        } else if (input == "sample") {
            command >> sample.sequence >> sample.age_ms >> sample.distance_mm;
        } else {
            peer.tick(now);
            for (size_t i = 0; i + 1 < input.size(); i += 2) {
                peer.receive(static_cast<uint8_t>(std::stoul(input.substr(i, 2), nullptr, 16)), now);
            }
        }
        std::cout << static_cast<unsigned>(output) << ' ' << reply << std::endl;
    }
}
