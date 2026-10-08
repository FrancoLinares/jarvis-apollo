#include "wifi_board.h"
#include "display/lcd_display.h"
#include "display/jarvis_dashboard_display.h"
#include "display/emote_display.h"
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <esp_timer.h>
#include <cstdlib>

#include "codecs/box_audio_codec.h"
#include "application.h"
#include "button.h"
#include "mcp_server.h"
#include "config.h"
#include "power_save_timer.h"
#include "i2c_device.h"

#include <esp_log.h>
#include <esp_lcd_panel_vendor.h>
#include <driver/i2c_master.h>

#include <esp_lcd_touch_gt911.h>
#include <esp_lvgl_port.h>
#include <lvgl.h>

#include <esp_lcd_panel_io.h>
#include <esp_lcd_panel_ops.h>
#include <esp_lcd_panel_rgb.h>

#define TAG "WaveshareEsp32s3TouchLCD43c"

class CustomBacklight : public Backlight {
public:
    CustomBacklight(esp_io_expander_handle_t io_handle)
        : Backlight(), io_handle_(io_handle) {}

protected:
    esp_io_expander_handle_t io_handle_;

    virtual void SetBrightnessImpl(uint8_t brightness) override {
        if (brightness > 100) brightness = 100;
        int flipped_brightness = 100 - brightness;

        custom_io_expander_set_pwm(io_handle_, flipped_brightness * 255 / 100);
    }
};


class WaveshareEsp32s3TouchLCD43c : public WifiBoard {
private:
    i2c_master_bus_handle_t i2c_bus_;
    // Tipo base, no LcdDisplay: el motor de expresiones no es un display LVGL.
    Display* display_ = nullptr;
    esp_io_expander_handle_t io_expander = NULL;
    PowerSaveTimer* power_save_timer_;
    CustomBacklight *backlight_;

    // El touch se consulta directo desde una tarea propia, en los dos caminos:
    // los gestos necesitan el trazo crudo del dedo, y es lo unico que despierta
    // la pantalla dormida (SendGesture -> NoteUserActivity).
    esp_lcd_touch_handle_t touch_handle_ = nullptr;
    static constexpr int kTapMaxTravelPx = 30;
    static constexpr int kSwipeMinTravelPx = 60;
    static constexpr uint32_t kTapMaxMs = 400;
    static constexpr uint32_t kDoubleTapWindowMs = 400;
    // Apenas por encima de kTapMaxMs: una pulsación recién pasa a ser
    // push-to-talk cuando ya es demasiado larga para ser un tap.
    static constexpr uint32_t kHoldToTalkMs = 450;
    static constexpr uint32_t kTouchPollMs = 20;
    static constexpr int kMaxTouchReadFailures = 25;

    void InitializePowerSaveTimer() {
        power_save_timer_ = new PowerSaveTimer(-1, 60, 300);
        power_save_timer_->OnEnterSleepMode([this]() {
            GetDisplay()->SetPowerSaveMode(true);
            GetBacklight()->SetBrightness(10); });
        power_save_timer_->OnExitSleepMode([this]() {
            GetDisplay()->SetPowerSaveMode(false);
            GetBacklight()->RestoreBrightness();});
        power_save_timer_->SetEnabled(true);
    }

    void InitializeGpio() {
        // Zero-initialize the GPIO configuration structure
        gpio_config_t io_conf = {};
        io_conf.intr_type = GPIO_INTR_DISABLE; // Disable interrupts for this pin
        io_conf.pin_bit_mask = 1ULL << BSP_LCD_TOUCH_INT;    // Select the GPIO pin using a bitmask
        io_conf.mode = GPIO_MODE_OUTPUT;          // Set pin as output
        io_conf.pull_up_en = GPIO_PULLUP_DISABLE; // Disable pull-up
        gpio_config(&io_conf); // Apply the configuration
    }

    void InitializeCodecI2c() {
        // Initialize I2C peripheral
        i2c_master_bus_config_t i2c_bus_cfg = {
            .i2c_port = I2C_NUM_0,
            .sda_io_num = BSP_I2C_SDA,
            .scl_io_num = BSP_I2C_SCL,
            .clk_source = I2C_CLK_SRC_DEFAULT,
            .glitch_ignore_cnt = 7,
            .trans_queue_depth = 0,
            .flags = {
                .enable_internal_pullup = 1,
            },
        };
        ESP_ERROR_CHECK(i2c_new_master_bus(&i2c_bus_cfg, &i2c_bus_));
    }

    void InitializeCustomio(void) {
        custom_io_expander_new_i2c_ch32v003(i2c_bus_, BSP_IO_EXPANDER_I2C_ADDRESS, &io_expander);
        esp_io_expander_set_dir(io_expander, BSP_POWER_AMP_IO | BSP_LCD_BACKLIGHT | BSP_LCD_TOUCH_RST , IO_EXPANDER_OUTPUT);
        esp_io_expander_set_level(io_expander, BSP_POWER_AMP_IO | BSP_LCD_BACKLIGHT | BSP_LCD_TOUCH_RST , 1);

        esp_io_expander_set_level(io_expander, BSP_LCD_TOUCH_RST, 0);
        vTaskDelay(pdMS_TO_TICKS(200));
        gpio_set_level(BSP_LCD_TOUCH_INT, 0);
        vTaskDelay(pdMS_TO_TICKS(200));
        esp_io_expander_set_level(io_expander, BSP_LCD_TOUCH_RST, 1);
        vTaskDelay(pdMS_TO_TICKS(200));
    }

    void InitializeRGB() {
        esp_lcd_panel_io_handle_t panel_io = nullptr;
        esp_lcd_panel_handle_t panel_handle = nullptr;

        esp_lcd_rgb_panel_config_t rgb_config = {
            .clk_src = LCD_CLK_SRC_DEFAULT,
            .timings = {
                // 16 MHz daba 39,5 Hz de refresco (816x496 con blanking): el panel
                // parpadeaba y todo lo que se movia se veia a los tirones. A 21 MHz
                // son 51,9 Hz. La PSRAM es Octal a 80 MHz, asi que hay ancho de banda;
                // si aparecieran lineas corridas, bajar a 18 MHz (44,5 Hz).
                // 16 MHz -> 39,5 Hz. Se habia subido a 21 (51,9 Hz) y con el motor
                // de caras andaba perfecto, pero LVGL corre con full_refresh y
                // repinta 768 KB por cuadro: sumado al DMA del panel leyendo la
                // misma PSRAM, a 21 MHz la banda no alcanza y parpadea.
                .pclk_hz = 16 * 1000 * 1000,
                .h_res = BSP_LCD_H_RES,
                .v_res = BSP_LCD_V_RES,
                .hsync_pulse_width = 4,
                .hsync_back_porch = 4,
                .hsync_front_porch = 8,
                .vsync_pulse_width = 4,
                .vsync_back_porch = 4,
                .vsync_front_porch = 8,
                .flags = {
                    .pclk_active_neg = true
                }
            },
            .data_width = 16,
            // ESP-IDF 5.5.2 usa bits_per_pixel; in_color_format/out_color_format
            // son de una versión posterior a la que fija este firmware.
            .bits_per_pixel = BSP_LCD_BITS_PER_PIXEL,
            .num_fbs = 2,
            .bounce_buffer_size_px = BSP_LCD_H_RES * 10,
            .dma_burst_size = 64,
            .hsync_gpio_num = BSP_LCD_HSYNC,
            .vsync_gpio_num = BSP_LCD_VSYNC,
            .de_gpio_num = BSP_LCD_DE,
            .pclk_gpio_num = BSP_LCD_PCLK,
            .disp_gpio_num = BSP_LCD_DISP,
            .data_gpio_nums = {
                BSP_LCD_DATA0, BSP_LCD_DATA1, BSP_LCD_DATA2, BSP_LCD_DATA3,
                BSP_LCD_DATA4, BSP_LCD_DATA5, BSP_LCD_DATA6, BSP_LCD_DATA7,
                BSP_LCD_DATA8, BSP_LCD_DATA9, BSP_LCD_DATA10, BSP_LCD_DATA11,
                BSP_LCD_DATA12, BSP_LCD_DATA13, BSP_LCD_DATA14, BSP_LCD_DATA15
            },
            .flags = {
                .fb_in_psram = 1,
            },
        };

        ESP_ERROR_CHECK(esp_lcd_new_rgb_panel(&rgb_config, &panel_handle));
        ESP_ERROR_CHECK(esp_lcd_panel_init(panel_handle));

#if CONFIG_USE_EMOTE_MESSAGE_STYLE
        // Ojos animados en vez de un glifo emoji. panel_io es nullptr porque un
        // panel RGB paralelo no lo tiene: EmoteDisplay detecta ese caso y trata
        // el flush como sincrónico (ver display/emote_display.cc).
        display_ = new emote::EmoteDisplay(panel_handle, panel_io, BSP_LCD_H_RES, BSP_LCD_V_RES);
#else
        // Tablero informativo en vez de la UI de chat: mismo RgbLcdDisplay por
        // debajo (init de LVGL, temas, locking), solo cambia SetupUI.
        //
        // OJO: si esta linea vuelve a RgbLcdDisplay, el linker DESCARTA todo
        // JarvisDashboardDisplay por falta de referencias y la pantalla queda en
        // blanco, sin un solo error de compilacion. Se detecta asi:
        //   strings build/xiaozhi.elf | grep "tablero armado"   -> 0 = descartado
        display_ = new JarvisDashboardDisplay(panel_io, panel_handle,
                                  BSP_LCD_H_RES, BSP_LCD_V_RES, DISPLAY_OFFSET_X, DISPLAY_OFFSET_Y, DISPLAY_MIRROR_X,
                                  DISPLAY_MIRROR_Y, DISPLAY_SWAP_XY);
#endif

        backlight_ = new CustomBacklight(io_expander);
        backlight_->RestoreBrightness();                    
    }

    void InitializeTouch() {
        esp_lcd_touch_handle_t tp;
        esp_lcd_touch_config_t tp_cfg = {
            .x_max = BSP_LCD_H_RES - 1,
            .y_max = BSP_LCD_V_RES - 1,
            .rst_gpio_num = GPIO_NUM_NC,
            .int_gpio_num = GPIO_NUM_NC,
            .levels = {
                .reset = 0,
                .interrupt = 0,
            },
            .flags = {
                .swap_xy = 0,
                .mirror_x = 0,
                .mirror_y = 0,
            },
        };
        esp_lcd_panel_io_handle_t tp_io_handle = NULL;
        esp_lcd_panel_io_i2c_config_t tp_io_config = {
            .dev_addr = ESP_LCD_TOUCH_IO_I2C_GT911_ADDRESS, 
            .control_phase_bytes = 1,
            .dc_bit_offset = 0,
            .lcd_cmd_bits = 16,                            
            .flags =
            {
                .disable_control_phase = 1,
            }
	    };
        tp_io_config.scl_speed_hz = 400 * 1000;

        esp_lcd_new_panel_io_i2c(i2c_bus_, &tp_io_config, &tp_io_handle);

        ESP_LOGI(TAG, "Initialize touch controller");
        ESP_ERROR_CHECK(esp_lcd_touch_new_i2c_gt911(tp_io_handle, &tp_cfg, &tp));
        // La tarea de gestos corre en LOS DOS caminos.
        //
        // Antes vivía solo bajo el motor de expresiones, y al pasar a LVGL el
        // táctil quedó compilado afuera: la pantalla se dormía a los 60s y ya no
        // había forma de despertarla, porque el que llama a NoteUserActivity es
        // justamente SendGesture. Se veía como "pantalla negra que no responde"
        // con la placa perfectamente viva.
        //
        // El tablero no tiene widgets que se toquen, así que NO se registra el
        // touch en LVGL: dos tareas leyendo el mismo GT911 por I2C es pelearse
        // por el bus para nada.
        touch_handle_ = tp;
        xTaskCreate([](void* arg) { static_cast<WaveshareEsp32s3TouchLCD43c*>(arg)->TouchGestureTask(); },
                    "touch_gesture", 4096, this, 4, nullptr);
        ESP_LOGI(TAG, "Touch panel initialized successfully");
    }

    // Portado del board 1.85C de Apollo. Aquel usa CST816S; este GT911. Las
    // lecturas van por la API genérica esp_lcd_touch, así que el único cambio
    // real es que el GT911 no tiene el auto-sleep del CST816S: no hace falta
    // re-armarlo, y un controlador mudo es un fallo de verdad.
    void TouchGestureTask() {
        bool was_pressed = false;
        int consecutive_read_failures = 0;
        int start_x = 0, start_y = 0, last_x = 0, last_y = 0;
        uint32_t press_started_ms = 0;
        uint32_t pending_tap_ms = 0;  // 0 = no hay tap esperando su ventana
        bool is_hold_talking = false;

        while (true) {
            uint32_t now_ms = (uint32_t)(esp_timer_get_time() / 1000);

            uint16_t x = 0, y = 0;
            uint8_t point_count = 0;
            if (esp_lcd_touch_read_data(touch_handle_) != ESP_OK) {
                // Un controlador que nunca contesta loguearía un error por
                // sondeo, para siempre. Mejor rendirse que ahogar el log.
                if (++consecutive_read_failures >= kMaxTouchReadFailures) {
                    ESP_LOGE(TAG, "Touch controller unresponsive, stopping gesture task");
                    vTaskDelete(nullptr);
                    return;
                }
                vTaskDelay(pdMS_TO_TICKS(kTouchPollMs));
                continue;
            }
            consecutive_read_failures = 0;
            bool is_pressed =
                esp_lcd_touch_get_coordinates(touch_handle_, &x, &y, nullptr, &point_count, 1) &&
                point_count > 0;

            // Una pantalla de confirmación se adueña del touch: al soltar se
            // resuelve el botón en el acto (esperar la ventana de doble tap los
            // haría sentir rotos) y una pulsación ya no puede volverse
            // push-to-talk. Un hold que empezó antes termina por el camino normal.
            if (Application::GetInstance().IsConfirmActive() && !is_hold_talking) {
                pending_tap_ms = 0;
                if (is_pressed && !was_pressed) {
                    start_x = last_x = x;
                    start_y = last_y = y;
                    press_started_ms = now_ms;
                } else if (is_pressed) {
                    last_x = x;
                    last_y = y;
                } else if (was_pressed) {
                    ESP_LOGI(TAG, "Confirm release at (%d,%d)", last_x, last_y);
                    Application::GetInstance().OnConfirmTouchRelease(last_x, last_y);
                }
                was_pressed = is_pressed;
                vTaskDelay(pdMS_TO_TICKS(kTouchPollMs));
                continue;
            }

            if (is_pressed && !was_pressed) {
                start_x = last_x = x;
                start_y = last_y = y;
                press_started_ms = now_ms;
            } else if (is_pressed) {
                last_x = x;
                last_y = y;
                // Mantener apretado para hablar: graba cuando la pulsación ya es
                // muy larga para ser un tap, y sigue hasta que se levanta el
                // dedo. El dedo tiene que quedarse quieto, o esto secuestraría
                // un swipe lento.
                if (!is_hold_talking && now_ms - press_started_ms >= kHoldToTalkMs &&
                    abs(last_x - start_x) < kTapMaxTravelPx &&
                    abs(last_y - start_y) < kTapMaxTravelPx) {
                    is_hold_talking = true;
                    pending_tap_ms = 0;
                    auto& app = Application::GetInstance();
                    // Un hold sobre la pantalla apagada debería encenderla Y
                    // grabar, no solo encenderla.
                    app.NoteUserActivity();
                    app.StartListening();
                }
            } else if (was_pressed) {
                if (is_hold_talking) {
                    // Levantar el dedo es lo que envía el turno.
                    is_hold_talking = false;
                    Application::GetInstance().StopListening();
                    was_pressed = is_pressed;
                    vTaskDelay(pdMS_TO_TICKS(kTouchPollMs));
                    continue;
                }

                int dx = last_x - start_x;
                int dy = last_y - start_y;
                uint32_t held_ms = now_ms - press_started_ms;

                if (abs(dx) >= kSwipeMinTravelPx && abs(dx) > abs(dy)) {
                    pending_tap_ms = 0;
                    EmitGesture(dx > 0 ? "swipe_right" : "swipe_left");
                } else if (held_ms <= kTapMaxMs && abs(dx) < kTapMaxTravelPx &&
                           abs(dy) < kTapMaxTravelPx) {
                    if (pending_tap_ms != 0) {
                        pending_tap_ms = 0;
                        EmitGesture("double_tap");
                    } else {
                        // El tap simple se retiene: recién es un tap cuando la
                        // ventana de doble tap se cierra sin una segunda pulsación.
                        pending_tap_ms = now_ms;
                    }
                }
            }

            if (pending_tap_ms != 0 && now_ms - pending_tap_ms > kDoubleTapWindowMs) {
                pending_tap_ms = 0;
                EmitGesture("tap");
            }

            was_pressed = is_pressed;
            vTaskDelay(pdMS_TO_TICKS(kTouchPollMs));
        }
    }

    void EmitGesture(const char* gesture) {
        ESP_LOGI(TAG, "Touch gesture: %s", gesture);
        Application::GetInstance().SendGesture(gesture);
    }

    // Initialization tool
    void InitializeTools() {
        auto &mcp_server = McpServer::GetInstance();
        mcp_server.AddTool("self.system.reconfigure_wifi",
            "Reboot the device and enter WiFi configuration mode.\n"
            "**CAUTION** You must ask the user to confirm this action.",
            PropertyList(), [this](const PropertyList& properties) {
                EnterWifiConfigMode();
                return true;
            });
    }

public:
    WaveshareEsp32s3TouchLCD43c() {
        InitializePowerSaveTimer();
        InitializeGpio();
        InitializeCodecI2c();
        InitializeCustomio();
        InitializeRGB();
        InitializeTouch();
        InitializeTools();
        GetBacklight()->SetBrightness(100);
    }

    virtual AudioCodec* GetAudioCodec() override {
        static BoxAudioCodec audio_codec(
            i2c_bus_, 
            AUDIO_INPUT_SAMPLE_RATE, 
            AUDIO_OUTPUT_SAMPLE_RATE,
            BSP_I2S_MCLK, 
            BSP_I2S_SCLK, 
            BSP_I2S_LCLK, 
            BSP_I2S_DOUT, 
            BSP_I2S_DSIN,
            BSP_PA_PIN, 
            BSP_CODEC_ES8311_ADDR, 
            BSP_CODEC_ES7210_ADDR, 
            AUDIO_INPUT_REFERENCE);
        return &audio_codec;
    }

    virtual Display* GetDisplay() override {
        return display_;
    }

    virtual Backlight *GetBacklight() override {
         return backlight_;
    }

    virtual void SetPowerSaveLevel(PowerSaveLevel level) override {
        if (level != PowerSaveLevel::LOW_POWER) {
            power_save_timer_->WakeUp();
        }
        WifiBoard::SetPowerSaveLevel(level);
    }
};

DECLARE_BOARD(WaveshareEsp32s3TouchLCD43c);
