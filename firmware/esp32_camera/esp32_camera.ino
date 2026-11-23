// Camera acquisition and httpd handling adapted from Espressif CameraWebServer.
// Copyright 2015-2016 Espressif Systems (Shanghai) PTE LTD
// SPDX-License-Identifier: Apache-2.0

#include <Arduino.h>
#include <WiFi.h>
#include <esp_camera.h>
#include <esp_heap_caps.h>
#include <esp_http_server.h>
#include <esp_random.h>
#include <esp_timer.h>
#include <img_converters.h>
#include <inttypes.h>

#define CAMERA_MODEL_AI_THINKER
#include "camera_pins.h"
#include "local_build.h"

constexpr size_t MaxJpeg = 64 * 1024;
constexpr size_t Width = 320;
constexpr size_t Height = 240;
constexpr uint64_t MaxInteger = 9007199254740991ULL;
constexpr char Hex[] = "0123456789abcdef";

char bootEpoch[33];
char streamEpoch[33];
uint64_t sequence = 0;
uint64_t lastCapture = 0;
uint8_t *jpeg = nullptr;

struct JpegWrite {
  size_t size = 0;
  bool overflow = false;
};

void randomId(char (&output)[33]) {
  uint8_t bytes[16];
  esp_fill_random(bytes, sizeof(bytes));
  for (size_t i = 0; i < sizeof(bytes); ++i) {
    output[2 * i] = Hex[bytes[i] >> 4];
    output[2 * i + 1] = Hex[bytes[i] & 15];
  }
  output[32] = '\0';
}

bool authorized(httpd_req_t *request) {
  char provided[sizeof(CameraAuthorization)] = {};
  if (request->content_len || httpd_req_get_hdr_value_str(
      request, "Authorization", provided, sizeof(provided)) != ESP_OK) {
    return false;
  }
  uint8_t difference = 0;
  for (size_t i = 0; i < sizeof(provided); ++i) {
    difference |= provided[i] ^ CameraAuthorization[i];
  }
  return difference == 0;
}

esp_err_t respond(httpd_req_t *request, const char *type, const char *header, const char *metadata,
                  const char *body, size_t size) {
  if (httpd_resp_set_type(request, type) != ESP_OK ||
      httpd_resp_set_hdr(request, "Cache-Control", "no-store") != ESP_OK ||
      httpd_resp_set_hdr(request, header, metadata) != ESP_OK) {
    return ESP_FAIL;
  }
  return httpd_resp_send(request, body, size);
}

esp_err_t clockResponse(httpd_req_t *request) {
  const int64_t received = esp_timer_get_time();
  if (!authorized(request)) {
    return httpd_resp_send_err(request, HTTPD_401_UNAUTHORIZED, nullptr);
  }
  char nonce[33];
  char expected[65];
  if (httpd_req_get_hdr_value_len(request, "X-LAF-Request") != 32 ||
      httpd_req_get_hdr_value_str(request, "X-LAF-Request", nonce, sizeof(nonce)) != ESP_OK ||
      strspn(nonce, Hex) != 32) {
    return httpd_resp_send_err(request, HTTPD_400_BAD_REQUEST, nullptr);
  }
  if (httpd_req_get_hdr_value_str(request, "X-LAF-Epoch", expected, sizeof(expected)) != ESP_OK ||
      (strcmp(expected, "0") != 0 && strspn(expected, Hex) != 64)) {
    return httpd_resp_send_err(request, HTTPD_400_BAD_REQUEST, nullptr);
  }
  char metadata[256];
  const int64_t transmitted = esp_timer_get_time();
  snprintf(metadata, sizeof(metadata), "1 %s %s %s %s %s %" PRId64 " %" PRId64,
           nonce, expected, CameraBuildId, bootEpoch, streamEpoch, received, transmitted);
  return respond(request, "application/octet-stream", "X-LAF-Clock", metadata, "", 0);
}

size_t writeJpeg(void *context, size_t offset, const void *bytes, size_t length) {
  auto &output = *static_cast<JpegWrite *>(context);
  if (offset > MaxJpeg || length > MaxJpeg - offset || offset != output.size) {
    output.overflow = true;
    return 0;
  }
  if (length != 0) {
    memcpy(jpeg + offset, bytes, length);
    output.size += length;
  }
  return length;
}

esp_err_t acquireFrame(httpd_req_t *request) {
  if (!authorized(request)) {
    return httpd_resp_send_err(request, HTTPD_401_UNAUTHORIZED, nullptr);
  }
  camera_fb_t *frame = esp_camera_fb_get();
  if (!frame) {
    return httpd_resp_send_err(request, HTTPD_500_INTERNAL_SERVER_ERROR, nullptr);
  }
  const uint64_t captured = uint64_t(frame->timestamp.tv_sec) * 1000000 + frame->timestamp.tv_usec;
  const bool eligible = captured > lastCapture && captured <= MaxInteger && sequence < MaxInteger &&
      frame->width == Width && frame->height == Height && frame->format == PIXFORMAT_RGB565 &&
      frame->len == Width * Height * 2;
  JpegWrite output;
  bool encoded = false;
  if (eligible) {
    lastCapture = captured;
    ++sequence;
    encoded = frame2jpg_cb(frame, 80, writeJpeg, &output);
  }
  esp_camera_fb_return(frame);
  if (!encoded || output.overflow || output.size == 0) {
    return httpd_resp_send_err(request, HTTPD_500_INTERNAL_SERVER_ERROR, nullptr);
  }
  char metadata[160];
  snprintf(metadata, sizeof(metadata), "1 %s %s %s %" PRIu64 " %" PRIu64 " %u %u",
           CameraBuildId, bootEpoch, streamEpoch, sequence, captured, unsigned(Width), unsigned(Height));
  return respond(request, "image/jpeg", "X-LAF-Frame", metadata, reinterpret_cast<char *>(jpeg), output.size);
}

bool startCameraServer() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = CameraPort;
  config.max_uri_handlers = 2;
  config.max_req_hdr_len = 512;
  config.max_open_sockets = 3;
  config.lru_purge_enable = true;
  config.recv_wait_timeout = 1;
  config.send_wait_timeout = 1;
  httpd_handle_t server = nullptr;
  if (httpd_start(&server, &config) != ESP_OK) {
    return false;
  }
  const httpd_uri_t clock = { .uri = "/laf/camera/v1/clock", .method = HTTP_GET, .handler = clockResponse };
  const httpd_uri_t frame = { .uri = "/laf/camera/v1/frame", .method = HTTP_GET, .handler = acquireFrame };
  if (httpd_register_uri_handler(server, &clock) != ESP_OK || httpd_register_uri_handler(server, &frame) != ESP_OK) {
    httpd_stop(server);
    return false;
  }
  return true;
}

void setup() {
  Serial.begin(115200);
  const bool psram = psramFound();
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_RGB565;
  config.frame_size = FRAMESIZE_QVGA;
  config.fb_count = 1;
  config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  config.fb_location = psram ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;
  if (esp_camera_init(&config) != ESP_OK) {
    Serial.println("Camera initialization failed");
    return;
  }
  const sensor_t *sensor = esp_camera_sensor_get();
  if (!sensor || sensor->id.PID != GC2145_PID) {
    Serial.println("Unexpected camera sensor");
    return;
  }
  jpeg = static_cast<uint8_t *>(heap_caps_malloc(MaxJpeg, (psram ? MALLOC_CAP_SPIRAM : MALLOC_CAP_INTERNAL)
                                               | MALLOC_CAP_8BIT));
  if (!jpeg) {
    Serial.println("Camera JPEG buffer unavailable");
    return;
  }
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(CameraSsid, CameraWifiPassword);
  WiFi.setAutoReconnect(true);
}

void loop() {
  static bool started = false;
  if (!started && jpeg && WiFi.status() == WL_CONNECTED) {
    randomId(bootEpoch);
    randomId(streamEpoch);
    started = startCameraServer();
    if (started) {
      Serial.printf("LAF camera v1 ready at %s:%u\n", WiFi.localIP().toString().c_str(), CameraPort);
    }
  }
  delay(250);
}
