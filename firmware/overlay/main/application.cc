#include "application.h"
#include "assets.h"
#include "assets/lang_config.h"
#include "assets/sound_variants.h"
#include "audio_codec.h"
#include "board.h"
#include "display.h"
#include "display/confirm_geometry.h"
#include "mcp_server.h"
#include "settings.h"
#include "system_info.h"
#include "text_glyph_payload.h"
#include "apollo_protocol.h"
// Se compila siempre (main/CMakeLists.txt lo tiene en la lista de fuentes sin
// condicion), asi que no lleva guarda: cuando el motor de caras esta activo el
// dynamic_cast simplemente da nullptr.
#include "display/jarvis_dashboard_display.h"
#if CONFIG_USE_EMOTE_MESSAGE_STYLE
#include "display/emote_display.h"
#endif

#include <driver/gpio.h>
#include <esp_log.h>
#ifdef CONFIG_APOLLO_PROTOCOL
#include <esp_app_desc.h>
#include <esp_system.h>
#include <esp_attr.h>
#include <esp_core_dump.h>
#include <esp_ota_ops.h>
#include <cstdarg>
#include <esp_netif_sntp.h>
#include <wifi_manager.h>
#endif
#include <arpa/inet.h>
#include <cJSON.h>
#include <algorithm>
#include <cstring>

#define TAG "Application"

#if defined(CONFIG_APOLLO_PROTOCOL) && defined(CONFIG_USE_EMOTE_MESSAGE_STYLE)
// Long enough that the idle animation finishes and the face rests before it
// plays again.
static constexpr int kIdleBlinkIntervalSeconds = 12;
#endif

#ifdef CONFIG_APOLLO_PROTOCOL
// The backlight is the single biggest draw on this board, so it goes first.
// 60s servian cuando la pantalla era una cara: apagarla no perdia nada. Un
// tablero informativo se mira de reojo al pasar, y uno que se apaga cada minuto
// no sirve para eso. 15 minutos deja la informacion a la vista todo el dia de
// trabajo y sigue apagando de noche.
static constexpr int kScreenSleepAfterSeconds = 900;
// Slow enough that a server that keeps hanging up does not turn into a
// reconnect loop, quick enough that the channel is ready when a hand arrives.
static constexpr int kChannelReopenMinSeconds = 5;
static constexpr int kChannelReopenMaxSeconds = 60;
static constexpr int kFirmwareHealthySeconds = 60;
// Draining the encoder after the finger lifts: a few short waits rather than one
// long one, so a quiet tail costs nothing but a real one still gets through.
static constexpr int kListenFlushAttempts = 6;
static constexpr int kListenFlushWaitMs = 40;
static constexpr int kTelemetryIntervalSeconds = 60;
#endif

Application::Application() {
    event_group_ = xEventGroupCreate();

#if CONFIG_USE_DEVICE_AEC && CONFIG_USE_SERVER_AEC
#error "CONFIG_USE_DEVICE_AEC and CONFIG_USE_SERVER_AEC cannot be enabled at the same time"
#elif CONFIG_USE_DEVICE_AEC
    aec_mode_ = kAecOnDeviceSide;
#elif CONFIG_USE_SERVER_AEC
    aec_mode_ = kAecOnServerSide;
#else
    aec_mode_ = kAecOff;
#endif

    esp_timer_create_args_t clock_timer_args = {.callback =
                                                    [](void* arg) {
                                                        Application* app = (Application*)arg;
                                                        xEventGroupSetBits(app->event_group_,
                                                                           MAIN_EVENT_CLOCK_TICK);
                                                        // Corre en la tarea de esp_timer, no en el
                                                        // loop principal: es lo único que puede
                                                        // notar que el loop se bloqueó.
                                                        app->CheckMainLoopHeartbeat();
                                                    },
                                                .arg = this,
                                                .dispatch_method = ESP_TIMER_TASK,
                                                .name = "clock_timer",
                                                .skip_unhandled_events = true};
    esp_timer_create(&clock_timer_args, &clock_timer_handle_);
}

Application::~Application() {
    if (clock_timer_handle_ != nullptr) {
        esp_timer_stop(clock_timer_handle_);
        esp_timer_delete(clock_timer_handle_);
    }
    vEventGroupDelete(event_group_);
}

bool Application::SetDeviceState(DeviceState state) { return state_machine_.TransitionTo(state); }

// ─── Guardianes contra la placa trabada ──────────────────────────────────────
//
// 2026-09-29: la placa quedó en el WiFi pero muda. No reconectaba (eso solo pasa
// en reposo) ni escuchaba "Hey Jarvis" (el detector también despacha al loop
// principal), y hubo que desenchufarla. Ya había pasado antes. El reinicio borró
// el estado, así que no se sabe si fue un estado trabado o el loop principal
// bloqueado: se cubren los dos, y cada intervención queda en el log serie.

// A. Loop principal bloqueado (por ejemplo, una conexión que nunca vuelve). El
// reloj de 1 s corre en otra tarea: si el loop no late en 90 s, reinicio.
static constexpr int64_t kMainLoopStallRestartUs = 90LL * 1000 * 1000;
// B. Estado trabado con el loop vivo: cuánto puede durar cada estado de trabajo
// antes de cortar y volver a reposo. Hablar es el más largo (respuestas de varias
// frases); conectar tarda ~3 s cuando anda.
static constexpr int kStuckConnectingSeconds = 60;
static constexpr int kStuckListeningSeconds = 120;
static constexpr int kStuckSpeakingSeconds = 300;
// C. Sin WiFi: si la placa lleva 20 minutos sin WiFi, la pila de red puede haber
// quedado mal y reiniciar la arregla.
//
// 2026-10-04: antes contaba "sin poder conectarse AL SERVIDOR". Con la Pi caída
// eso reiniciaba la placa cada 20 minutos, para siempre y sonando en cada
// arranque, sin arreglar nada: el problema no estaba en la placa. Con el WiFi
// arriba, la placa sigue reintentando el servidor sola (cada 5-60 s).
static constexpr int kDisconnectedIdleRestartSeconds = 20 * 60;

// Nota del guardián: sobrevive a esp_restart() (RTC sin inicializar) para que al
// volver la placa pueda contarle al servidor por qué se reinició.
struct GuardianNote {
    uint32_t magic;
    char reason[120];
};
static RTC_NOINIT_ATTR GuardianNote s_guardian_note;
static constexpr uint32_t kGuardianNoteMagic = 0x4A415256;  // "JARV"

static void RestartWithGuardianNote(const char* format, ...) {
    va_list arguments;
    va_start(arguments, format);
    vsnprintf(s_guardian_note.reason, sizeof(s_guardian_note.reason), format, arguments);
    va_end(arguments);
    s_guardian_note.magic = kGuardianNoteMagic;
    ESP_LOGE(TAG, "Guardian: %s; reinicio", s_guardian_note.reason);
    esp_restart();
}

static const char* DescribeResetReason(esp_reset_reason_t reason) {
    switch (reason) {
        case ESP_RST_POWERON: return "poweron";
        case ESP_RST_EXT: return "external";
        case ESP_RST_SW: return "software";
        case ESP_RST_PANIC: return "panic";
        case ESP_RST_INT_WDT: return "int_wdt";
        case ESP_RST_TASK_WDT: return "task_wdt";
        case ESP_RST_WDT: return "wdt";
        case ESP_RST_DEEPSLEEP: return "deepsleep";
        case ESP_RST_BROWNOUT: return "brownout";
        case ESP_RST_SDIO: return "sdio";
        case ESP_RST_USB: return "usb";
        case ESP_RST_JTAG: return "jtag";
        default: return "unknown";
    }
}

// Con rollback habilitado, una imagen instalada por OTA arranca "pendiente" y
// vuelve a la anterior al próximo reinicio si no se marca como buena. Antes se
// marcaba apenas arrancaba; ahora recién tras kFirmwareHealthySeconds conectada.
static void MarkRunningFirmwareValid() {
    const esp_partition_t* partition = esp_ota_get_running_partition();
    esp_ota_img_states_t state;
    if (partition == nullptr || esp_ota_get_state_partition(partition, &state) != ESP_OK) {
        return;
    }
    if (state == ESP_OTA_IMG_PENDING_VERIFY) {
        ESP_LOGI(TAG, "Firmware %s estable: se marca como válido", esp_app_get_description()->version);
        esp_ota_mark_app_valid_cancel_rollback();
    }
}

void Application::BuildBootReport() {
    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "boot_report");
    esp_reset_reason_t reset_reason = esp_reset_reason();
    cJSON_AddStringToObject(root, "resetReason", DescribeResetReason(reset_reason));
    cJSON_AddStringToObject(root, "firmwareVersion", esp_app_get_description()->version);
    if (s_guardian_note.magic == kGuardianNoteMagic && reset_reason == ESP_RST_SW) {
        s_guardian_note.reason[sizeof(s_guardian_note.reason) - 1] = '\0';
        cJSON_AddStringToObject(root, "guardianReason", s_guardian_note.reason);
    }
    s_guardian_note.magic = 0;
    if (esp_core_dump_image_check() == ESP_OK) {
        esp_core_dump_summary_t* summary =
            static_cast<esp_core_dump_summary_t*>(malloc(sizeof(esp_core_dump_summary_t)));
        if (summary != nullptr && esp_core_dump_get_summary(summary) == ESP_OK) {
            cJSON* crash = cJSON_CreateObject();
            cJSON_AddStringToObject(crash, "task", summary->exc_task);
            char pc[20];
            snprintf(pc, sizeof(pc), "0x%08lx", (unsigned long)summary->exc_pc);
            cJSON_AddStringToObject(crash, "pc", pc);
            std::string backtrace;
            for (uint32_t index = 0; index < summary->exc_bt_info.depth && index < 16; index++) {
                char frame[12];
                snprintf(frame, sizeof(frame), "0x%08lx ", (unsigned long)summary->exc_bt_info.bt[index]);
                backtrace += frame;
            }
            cJSON_AddStringToObject(crash, "backtrace", backtrace.c_str());
            cJSON_AddItemToObject(root, "crash", crash);
        }
        free(summary);
    }
    char* text = cJSON_PrintUnformatted(root);
    pending_boot_report_ = text;
    ESP_LOGI(TAG, "Arranque: %s", text);
    cJSON_free(text);
    cJSON_Delete(root);
}

void Application::MaybeSendBootReport() {
    if (pending_boot_report_.empty() || protocol_ == nullptr || !protocol_->IsAudioChannelOpened()) {
        return;
    }
    if (protocol_->SendJsonMessage(pending_boot_report_)) {
        pending_boot_report_.clear();
        // Ya informado: el volcado se borra para no reportarlo en cada arranque.
        if (esp_core_dump_image_check() == ESP_OK) {
            esp_core_dump_image_erase();
        }
    }
}

void Application::CheckMainLoopHeartbeat() {
    int64_t last_heartbeat_us = main_loop_heartbeat_us_.load();
    if (last_heartbeat_us == 0) {
        return;  // El loop todavía no arrancó.
    }
    DeviceState state = GetDeviceState();
    // Estados donde el loop puede estar ocupado a propósito mucho tiempo.
    if (state == kDeviceStateUpgrading || state == kDeviceStateActivating ||
        state == kDeviceStateStarting || state == kDeviceStateWifiConfiguring ||
        state == kDeviceStateAudioTesting) {
        return;
    }
    int64_t stalled_us = esp_timer_get_time() - last_heartbeat_us;
    if (stalled_us > kMainLoopStallRestartUs) {
        RestartWithGuardianNote("loop principal sin latido %lld s (estado %d)", stalled_us / 1000000,
                                (int)state);
    }
}

void Application::RunStuckStateWatchdog() {
    DeviceState state = GetDeviceState();
    if (state != watched_state_) {
        watched_state_ = state;
        watched_state_since_ticks_ = clock_ticks_;
    }
    int seconds_in_state = clock_ticks_ - watched_state_since_ticks_;
    bool channel_open = protocol_ != nullptr && protocol_->IsAudioChannelOpened();

    // Latido en el log: si se vuelve a trabar, esto dice en qué estado quedó.
    if (clock_ticks_ % 60 == 0) {
        ESP_LOGI(TAG, "Latido: estado %d hace %d s, canal %s", (int)state, seconds_in_state,
                 channel_open ? "abierto" : "cerrado");
    }

    int limit_seconds = 0;
    if (state == kDeviceStateConnecting) {
        limit_seconds = kStuckConnectingSeconds;
    } else if (state == kDeviceStateListening) {
        limit_seconds = kStuckListeningSeconds;
    } else if (state == kDeviceStateSpeaking) {
        limit_seconds = kStuckSpeakingSeconds;
    }
    if (limit_seconds > 0 && seconds_in_state >= limit_seconds) {
        ESP_LOGE(TAG, "Guardian: %d s en estado %d (canal %s); vuelvo a reposo", seconds_in_state,
                 (int)state, channel_open ? "abierto" : "cerrado");
        if (state == kDeviceStateSpeaking) {
            AbortSpeaking(kAbortReasonNone);
        }
        pending_speech_stop_ = false;
        pending_listening_start_ = false;
        if (channel_open) {
            protocol_->CloseAudioChannel();
        }
        SetDeviceState(kDeviceStateIdle);
        watched_state_since_ticks_ = clock_ticks_;
        return;
    }

    const bool wifi_up = WifiManager::GetInstance().IsConnected();
    if (state == kDeviceStateIdle && protocol_ != nullptr && !channel_open && !wifi_up) {
        if (disconnected_idle_since_ticks_ < 0) {
            disconnected_idle_since_ticks_ = clock_ticks_;
        } else if (clock_ticks_ - disconnected_idle_since_ticks_ >= kDisconnectedIdleRestartSeconds) {
            RestartWithGuardianNote("%d s en reposo sin WiFi",
                                    clock_ticks_ - disconnected_idle_since_ticks_);
        }
    } else {
        disconnected_idle_since_ticks_ = -1;
    }

    // Salud: canal abierto sin cortes. Da por buena la versión (rollback) y
    // resetea el intervalo de reconexión.
    if (channel_open) {
        healthy_channel_seconds_++;
        channel_reopen_interval_seconds_ = kChannelReopenMinSeconds;
        if (!firmware_marked_valid_ && healthy_channel_seconds_ >= kFirmwareHealthySeconds) {
            MarkRunningFirmwareValid();
            firmware_marked_valid_ = true;
        }
    } else {
        healthy_channel_seconds_ = 0;
    }
    MaybeSendBootReport();
}

void Application::Initialize() {
    auto& board = Board::GetInstance();
    SetDeviceState(kDeviceStateStarting);
    // Antes que nada: por qué arrancó (se manda al servidor al conectar).
    BuildBootReport();

    // Setup the display
    auto display = board.GetDisplay();
    display->SetupUI();
    // Print board name/version info
    display->SetChatMessage("system", SystemInfo::GetUserAgent().c_str());

    // Setup the audio service
    auto codec = board.GetAudioCodec();
    audio_service_.Initialize(codec);
    audio_service_.Start();

    AudioServiceCallbacks callbacks;
    callbacks.on_send_queue_available = [this]() {
        xEventGroupSetBits(event_group_, MAIN_EVENT_SEND_AUDIO);
    };
    callbacks.on_wake_word_detected = [this](const std::string& wake_word) {
        xEventGroupSetBits(event_group_, MAIN_EVENT_WAKE_WORD_DETECTED);
    };
    callbacks.on_vad_change = [this](bool speaking) {
        const int64_t now = esp_timer_get_time();
        vad_in_speech_.store(speaking);
        if (speaking) {
            vad_last_onset_us_.store(now);
        } else {
            vad_last_offset_us_.store(now);
        }
        xEventGroupSetBits(event_group_, MAIN_EVENT_VAD_CHANGE);
    };
    callbacks.on_playback_drained = [this]() {
        xEventGroupSetBits(event_group_, MAIN_EVENT_PLAYBACK_DRAINED);
    };
    audio_service_.SetCallbacks(callbacks);

    // Add state change listeners
    state_machine_.AddStateChangeListener([this](DeviceState old_state, DeviceState new_state) {
        xEventGroupSetBits(event_group_, MAIN_EVENT_STATE_CHANGED);
    });

    // Start the clock timer to update the status bar
    esp_timer_start_periodic(clock_timer_handle_, 1000000);

    // Add MCP common tools (only once during initialization)
    auto& mcp_server = McpServer::GetInstance();
    mcp_server.AddCommonTools();
    mcp_server.AddUserOnlyTools();

    // Set network event callback for UI updates and network state handling
    board.SetNetworkEventCallback([this](NetworkEvent event, const std::string& data) {
        auto display = Board::GetInstance().GetDisplay();

        switch (event) {
            case NetworkEvent::Scanning:
                display->ShowNotification(Lang::Strings::SCANNING_WIFI, 30000);
                xEventGroupSetBits(event_group_, MAIN_EVENT_NETWORK_DISCONNECTED);
                break;
            case NetworkEvent::Connecting: {
                if (data.empty()) {
                    // Cellular network - registering without carrier info yet
                    display->SetStatus(Lang::Strings::REGISTERING_NETWORK);
                } else {
                    // WiFi or cellular with carrier info
                    std::string msg = Lang::Strings::CONNECT_TO;
                    msg += data;
                    msg += "...";
                    display->ShowNotification(msg.c_str(), 30000);
                }
                break;
            }
            case NetworkEvent::Connected: {
                std::string msg = Lang::Strings::CONNECTED_TO;
                msg += data;
                display->ShowNotification(msg.c_str(), 30000);
                xEventGroupSetBits(event_group_, MAIN_EVENT_NETWORK_CONNECTED);
                break;
            }
            case NetworkEvent::Disconnected:
                xEventGroupSetBits(event_group_, MAIN_EVENT_NETWORK_DISCONNECTED);
                break;
            case NetworkEvent::WifiConfigModeEnter:
                // WiFi config mode enter is handled by WifiBoard internally
                break;
            case NetworkEvent::WifiConfigModeExit:
                // WiFi config mode exit is handled by WifiBoard internally
                break;
            // Cellular modem specific events
            case NetworkEvent::ModemDetecting:
                display->SetStatus(Lang::Strings::DETECTING_MODULE);
                break;
            case NetworkEvent::ModemErrorNoSim:
                Alert(Lang::Strings::ERROR, Lang::Strings::PIN_ERROR, "warning",
                      Lang::Sounds::OGG_ERR_PIN);
                break;
            case NetworkEvent::ModemErrorRegDenied:
                Alert(Lang::Strings::ERROR, Lang::Strings::REG_ERROR, "warning",
                      Lang::Sounds::OGG_ERR_REG);
                break;
            case NetworkEvent::ModemErrorInitFailed:
                Alert(Lang::Strings::ERROR, Lang::Strings::MODEM_INIT_ERROR, "warning",
                      Lang::Sounds::OGG_EXCLAMATION);
                break;
            case NetworkEvent::ModemErrorTimeout:
                display->SetStatus(Lang::Strings::REGISTERING_NETWORK);
                break;
        }
    });

    // Start network asynchronously
    board.StartNetwork();

    // Update the status bar immediately to show the network state
    display->UpdateStatusBar(true);
}

void Application::Run() {
    // Set the priority of the main task to 10
    vTaskPrioritySet(nullptr, 10);

    const EventBits_t ALL_EVENTS =
        MAIN_EVENT_SCHEDULE | MAIN_EVENT_SEND_AUDIO | MAIN_EVENT_WAKE_WORD_DETECTED |
        MAIN_EVENT_VAD_CHANGE | MAIN_EVENT_CLOCK_TICK | MAIN_EVENT_ERROR |
        MAIN_EVENT_NETWORK_CONNECTED | MAIN_EVENT_NETWORK_DISCONNECTED | MAIN_EVENT_TOGGLE_CHAT |
        MAIN_EVENT_START_LISTENING | MAIN_EVENT_STOP_LISTENING | MAIN_EVENT_ACTIVATION_DONE |
        MAIN_EVENT_STATE_CHANGED | MAIN_EVENT_PLAYBACK_DRAINED | MAIN_EVENT_LISTEN_WATCHDOG;

    main_loop_heartbeat_us_.store(esp_timer_get_time());
    while (true) {
        auto bits = xEventGroupWaitBits(event_group_, ALL_EVENTS, pdTRUE, pdFALSE, portMAX_DELAY);
        // El reloj despierta este loop cada segundo: si deja de latir, el
        // guardián del timer lo nota (CheckMainLoopHeartbeat).
        main_loop_heartbeat_us_.store(esp_timer_get_time());

        if (bits & MAIN_EVENT_ERROR) {
            SetDeviceState(kDeviceStateIdle);
            // Un reconectar de fondo que falla no merece alerta: antes, con la
            // Pi caída, la placa pitaba cada 10 s. Solo se avisa lo que el
            // usuario pidió.
            bool from_background_reopen =
                esp_timer_get_time() - last_background_reopen_failure_us_ < 2 * 1000 * 1000;
            if (from_background_reopen) {
                ESP_LOGW(TAG, "Background reconnect error (silenced): %s", last_error_message_.c_str());
            } else {
                Alert(Lang::Strings::ERROR, last_error_message_.c_str(), "cancel",
                      Lang::Sounds::OGG_EXCLAMATION);
            }
        }

        if (bits & MAIN_EVENT_NETWORK_CONNECTED) {
            HandleNetworkConnectedEvent();
        }

        if (bits & MAIN_EVENT_NETWORK_DISCONNECTED) {
            HandleNetworkDisconnectedEvent();
        }

        if (bits & MAIN_EVENT_ACTIVATION_DONE) {
            HandleActivationDoneEvent();
        }

        if (bits & MAIN_EVENT_STATE_CHANGED) {
            HandleStateChangedEvent();
        }

        if (bits & MAIN_EVENT_PLAYBACK_DRAINED) {
            // Deferred listening start (auto mode): the playback queue has
            // drained, so it is now safe to enable voice processing.
            if (pending_listening_start_ && GetDeviceState() == kDeviceStateListening &&
                audio_service_.IsPlaybackIdle()) {
                pending_listening_start_ = false;
                StartListeningAudio();
            }

            // Deferred end of speech: the reply had finished arriving long
            // before it finished playing.
            if (pending_speech_stop_ && GetDeviceState() == kDeviceStateSpeaking &&
                audio_service_.IsPlaybackIdle()) {
                pending_speech_stop_ = false;
                FinishSpeaking();
            }
        }

        if (bits & MAIN_EVENT_TOGGLE_CHAT) {
            HandleToggleChatEvent();
        }

        if (bits & MAIN_EVENT_START_LISTENING) {
            HandleStartListeningEvent();
        }

        if (bits & MAIN_EVENT_STOP_LISTENING) {
            HandleStopListeningEvent();
        }

        if (bits & MAIN_EVENT_SEND_AUDIO) {
            while (auto packet = audio_service_.PopPacketFromSendQueue()) {
                if (protocol_ && !protocol_->SendAudio(std::move(packet))) {
                    // Drop the remaining packets. Leaving them in the queue would
                    // stall the Opus codec task (it waits for queue space), which in
                    // turn deadlocks the whole audio input pipeline, as no new
                    // MAIN_EVENT_SEND_AUDIO event would ever be triggered again.
                    while (audio_service_.PopPacketFromSendQueue())
                        ;
                    break;
                }
            }
        }

        if (bits & MAIN_EVENT_WAKE_WORD_DETECTED) {
            HandleWakeWordDetectedEvent();
        }

        if (bits & MAIN_EVENT_VAD_CHANGE) {
            if (GetDeviceState() == kDeviceStateListening) {
                auto led = Board::GetInstance().GetLed();
                led->OnStateChanged();
            }
        }

        if (bits & MAIN_EVENT_LISTEN_WATCHDOG) {
            HandleListenWatchdogEvent();
        }

        if (bits & MAIN_EVENT_SCHEDULE) {
            std::unique_lock<std::mutex> lock(mutex_);
            auto tasks = std::move(main_tasks_);
            lock.unlock();
            for (auto& task : tasks) {
                task();
            }
        }

        if (bits & MAIN_EVENT_CLOCK_TICK) {
            clock_ticks_++;
            auto display = Board::GetInstance().GetDisplay();
            display->UpdateStatusBar();

#ifdef CONFIG_APOLLO_PROTOCOL
            if (GetDeviceState() == kDeviceStateIdle) {
                idle_seconds_++;
                if (idle_seconds_ >= kScreenSleepAfterSeconds) {
                    SleepScreen();
                }
                // Opening the channel on demand costs about three seconds, which
                // is longer than a press-and-hold lasts: the turn would be over
                // before the first sample was recorded. Reconnect while idle so
                // the press finds the channel already open.
                if (protocol_ != nullptr && !protocol_->IsAudioChannelOpened() &&
                    clock_ticks_ - last_channel_attempt_ticks_ >= channel_reopen_interval_seconds_) {
                    last_channel_attempt_ticks_ = clock_ticks_;
                    Schedule([this]() {
                        if (GetDeviceState() != kDeviceStateIdle || protocol_ == nullptr ||
                            protocol_->IsAudioChannelOpened()) {
                            return;
                        }
                        if (!protocol_->OpenAudioChannel()) {
                            // Intento de fondo: sin alerta ni pitido (ver el
                            // manejo de MAIN_EVENT_ERROR), y el próximo más
                            // espaciado para no martillar un servidor caído.
                            last_background_reopen_failure_us_ = esp_timer_get_time();
                            channel_reopen_interval_seconds_ =
                                std::min(channel_reopen_interval_seconds_ * 2, kChannelReopenMaxSeconds);
                            ESP_LOGW(TAG, "Idle channel reopen failed; retrying in %d s",
                                     channel_reopen_interval_seconds_);
                        }
                    });
                }
            } else {
                // Anything but idle is the device working for the user.
                NoteUserActivity();
            }
            MaybeSendTelemetry();
            RunStuckStateWatchdog();
            // Playback acks close the server's pacing loop. Speaking covers the
            // post-run drain too: FinishSpeaking is deferred until the queue
            // empties, and effect playback outside a turn must not ack.
            if (protocol_ != nullptr && protocol_->IsAudioChannelOpened() &&
                GetDeviceState() == kDeviceStateSpeaking) {
                protocol_->SendPlaybackAck(audio_service_.played_tts_milliseconds());
            }
#endif

#if defined(CONFIG_APOLLO_PROTOCOL) && defined(CONFIG_USE_EMOTE_MESSAGE_STYLE)
            // neutral.eaf is one blink, not an idle loop: looping it blinks
            // nonstop, which reads as a nervous tic. Play it once and replay it
            // on a human-ish cadence so the face rests in between. Pointless
            // while the screen is dark.
            if (!is_screen_asleep_ && clock_ticks_ % kIdleBlinkIntervalSeconds == 0 &&
                GetDeviceState() == kDeviceStateIdle) {
                display->SetEmotion("neutral");
            }
#endif

            // Print debug info every 10 seconds
            if (clock_ticks_ % 10 == 0) {
                SystemInfo::PrintHeapStats();
                // SystemInfo::PrintTaskList();
                // SystemInfo::PrintTaskCpuUsage(pdMS_TO_TICKS(1000));
            }
        }
    }
}

void Application::MaybeSendTelemetry() {
#ifdef CONFIG_APOLLO_PROTOCOL
    if (protocol_ == nullptr || !protocol_->IsAudioChannelOpened()) {
        telemetry_sent_since_open_ = false;
        return;
    }

    auto& board = Board::GetInstance();
    DeviceTelemetry telemetry;
    int battery_level = 0;
    bool charging = false;
    bool discharging = false;
    if (board.GetBatteryLevel(battery_level, charging, discharging)) {
        telemetry.battery_level = battery_level;
        telemetry.battery_valid = true;
        telemetry.charging = charging;
        telemetry.charging_valid = true;
    }
    telemetry.volume = board.GetAudioCodec()->output_volume();
    telemetry.wifi_rssi = WifiManager::GetInstance().GetRssi();
    telemetry.firmware_version = esp_app_get_description()->version;

    bool is_first_since_open = !telemetry_sent_since_open_;
    bool is_interval_due = clock_ticks_ - last_telemetry_ticks_ >= kTelemetryIntervalSeconds;
    // A charging edge jumps the queue: waiting a minute to learn the cable was
    // plugged or pulled makes the server's reactions feel broken.
    bool did_charging_flip = !is_first_since_open && telemetry.charging_valid &&
                             telemetry.charging != last_reported_charging_;
    if (!is_first_since_open && !is_interval_due && !did_charging_flip) {
        return;
    }

    telemetry_sent_since_open_ = true;
    last_telemetry_ticks_ = clock_ticks_;
    if (telemetry.charging_valid) {
        last_reported_charging_ = telemetry.charging;
    }
    protocol_->SendTelemetry(telemetry);
#endif
}

void Application::HandleNetworkConnectedEvent() {
    ESP_LOGI(TAG, "Network connected");
    auto state = GetDeviceState();

    if (state == kDeviceStateStarting || state == kDeviceStateWifiConfiguring) {
        // Network is ready, start activation
        SetDeviceState(kDeviceStateActivating);
        if (activation_task_handle_ != nullptr) {
            ESP_LOGW(TAG, "Activation task already running");
            return;
        }

        xTaskCreate(
            [](void* arg) {
                Application* app = static_cast<Application*>(arg);
                app->ActivationTask();
                app->activation_task_handle_ = nullptr;
                vTaskDelete(NULL);
            },
            "activation", 4096 * 2, this, 2, &activation_task_handle_);
    }

    // Update the status bar immediately to show the network state
    auto display = Board::GetInstance().GetDisplay();
    display->UpdateStatusBar(true);
}

void Application::HandleNetworkDisconnectedEvent() {
    // Close current conversation when network disconnected
    auto state = GetDeviceState();
    if (state == kDeviceStateConnecting || state == kDeviceStateListening ||
        state == kDeviceStateSpeaking) {
        ESP_LOGI(TAG, "Closing audio channel due to network disconnection");
        protocol_->CloseAudioChannel();
    }

    // Update the status bar immediately to show the network state
    auto display = Board::GetInstance().GetDisplay();
    display->UpdateStatusBar(true);
}

void Application::HandleActivationDoneEvent() {
    ESP_LOGI(TAG, "Activation done");

    SystemInfo::PrintHeapStats();
    SetDeviceState(kDeviceStateIdle);

    std::string version = esp_app_get_description()->version;
#ifdef CONFIG_APOLLO_PROTOCOL
    // ota_ is still in use by the activation task's deferred firmware check;
    // it also owns releasing it. Server time comes from SNTP under Apollo.
#else
    has_server_time_ = ota_->HasServerTime();
    version = ota_->GetCurrentVersion();
    ota_.reset();
#endif

    auto display = Board::GetInstance().GetDisplay();
    std::string message = std::string(Lang::Strings::VERSION) + version;
    display->ShowNotification(message.c_str());
    display->SetChatMessage("system", "");

    auto& board = Board::GetInstance();
    board.SetPowerSaveLevel(PowerSaveLevel::LOW_POWER);

    // El sonido de "lista" solo cuando la enchufan: después de un reinicio
    // automático (guardián, pánico, watchdog) arranca en silencio. Que sonara en
    // cada reinicio era molesto justamente cuando algo andaba mal.
    if (esp_reset_reason() == ESP_RST_POWERON) {
        Schedule([this]() {
            audio_service_.PlaySound(Lang::Sounds::OGG_SUCCESS);
        });
    }
}

void Application::ActivationTask() {
    // Create OTA object for activation process. Still constructed under Apollo:
    // HandleActivationDoneEvent reads the version and server time off it.
    ota_ = std::make_unique<Ota>();

    // Mounts the assets partition as a side effect of first touching the
    // Assets singleton, so it runs under Apollo too: skipping it left the
    // emote engine with no animations to play at all. The network path inside
    // only runs when a download url was explicitly stored.
    CheckAssetsVersion();

#ifndef CONFIG_APOLLO_PROTOCOL
    // Check for new firmware version
    CheckNewVersion();
#else
    // Apollo is configured locally and has no activation service, so the
    // xiaozhi handshake is skipped entirely: running it would block here
    // against api.tenclass.net waiting for a device registration that will
    // never happen.
    ESP_LOGI(TAG, "Apollo protocol selected, skipping OTA activation");
    InitializeSystemTime();
#endif

    // Initialize the protocol
    InitializeProtocol();

    // Signal completion to main loop
    xEventGroupSetBits(event_group_, MAIN_EVENT_ACTIVATION_DONE);

#ifdef CONFIG_APOLLO_PROTOCOL
    // After the ready signal on purpose: the check is a full HTTPS round trip
    // (~2.5 s) and the device is perfectly usable while it runs. ota_ is
    // released here, not in the handler, so the check can't race its owner.
    CheckApolloFirmwareUpdate();
    ota_.reset();
#endif
}

#ifdef CONFIG_APOLLO_PROTOCOL
void Application::CheckApolloFirmwareUpdate() {
    // Ya NO se marca como válida acá: eso se hace recién tras 60 s seguidos con
    // el canal abierto (RunStuckStateWatchdog → MarkRunningFirmwareValid), así
    // una versión que arranca pero se cuelga vuelve sola a la anterior.

    Settings settings("apollo", false);
    std::string base_url = settings.GetString("url");
    if (base_url.empty()) {
        base_url = CONFIG_APOLLO_URL;
    }
    std::string token = settings.GetString("token");
    if (token.empty()) {
        token = CONFIG_APOLLO_TOKEN;
    }
    if (base_url.empty() || token.empty()) {
        ESP_LOGW(TAG, "Apollo url or token not configured, skipping firmware check");
        return;
    }

    if (base_url.rfind("wss://", 0) == 0) {
        base_url = "https://" + base_url.substr(6);
    } else if (base_url.rfind("ws://", 0) == 0) {
        base_url = "http://" + base_url.substr(5);
    }
    while (!base_url.empty() && base_url.back() == '/') {
        base_url.pop_back();
    }
    ota_->SetCheckVersionUrl(base_url + "/ota/check?token=" + token);

    // A single attempt with no retries: unlike xiaozhi's activation loop, a
    // failed check must never hold the device in kDeviceStateActivating.
    esp_err_t error = ota_->CheckVersion();
    if (error != ESP_OK) {
        ESP_LOGW(TAG, "Apollo firmware check failed (0x%x), continuing boot", error);
        return;
    }
    if (!ota_->HasNewVersion()) {
        ESP_LOGI(TAG, "Firmware %s is current", ota_->GetCurrentVersion().c_str());
        return;
    }
    ESP_LOGI(TAG, "Upgrading firmware %s -> %s", ota_->GetCurrentVersion().c_str(),
             ota_->GetFirmwareVersion().c_str());
    UpgradeFirmware(ota_->GetFirmwareUrl(), ota_->GetFirmwareVersion());
}
#endif

void Application::CheckAssetsVersion() {
    // Only allow CheckAssetsVersion to be called once
    if (assets_version_checked_) {
        return;
    }
    assets_version_checked_ = true;

    auto& board = Board::GetInstance();
    auto display = board.GetDisplay();
    auto& assets = Assets::GetInstance();

    if (!assets.partition_valid()) {
        ESP_LOGW(TAG, "Assets partition is disabled for board %s", BOARD_NAME);
        return;
    }

    Settings settings("assets", true);
    // Check if there is a new assets need to be downloaded
    std::string download_url = settings.GetString("download_url");

    if (!download_url.empty()) {
        settings.EraseKey("download_url");

        char message[256];
        snprintf(message, sizeof(message), Lang::Strings::FOUND_NEW_ASSETS, download_url.c_str());
        Alert(Lang::Strings::LOADING_ASSETS, message, "cloud_download", Lang::Sounds::OGG_UPGRADE);

        // Wait for the audio service to be idle for 3 seconds
        vTaskDelay(pdMS_TO_TICKS(3000));
        SetDeviceState(kDeviceStateUpgrading);
        board.SetPowerSaveLevel(PowerSaveLevel::PERFORMANCE);
        display->SetChatMessage("system", Lang::Strings::PLEASE_WAIT);

        bool success =
            assets.Download(download_url, [this, display](int progress, size_t speed) -> void {
                char buffer[32];
                snprintf(buffer, sizeof(buffer), "%d%% %uKB/s", progress, speed / 1024);
                Schedule([display, message = std::string(buffer)]() {
                    display->SetChatMessage("system", message.c_str());
                });
            });

        board.SetPowerSaveLevel(PowerSaveLevel::LOW_POWER);
        vTaskDelay(pdMS_TO_TICKS(1000));

        if (!success) {
            Alert(Lang::Strings::ERROR, Lang::Strings::DOWNLOAD_ASSETS_FAILED, "cancel",
                  Lang::Sounds::OGG_EXCLAMATION);
            vTaskDelay(pdMS_TO_TICKS(2000));
            SetDeviceState(kDeviceStateActivating);
            return;
        }
    }

    // Apply assets
    assets.Apply();
    display->SetChatMessage("system", "");
    display->SetEmotion("robot_2");

}

void Application::CheckNewVersion() {
    const int MAX_RETRY = 10;
    int retry_count = 0;
    int retry_delay = 10;  // Initial retry delay in seconds

    auto& board = Board::GetInstance();
    while (true) {
        auto display = board.GetDisplay();
        display->SetStatus(Lang::Strings::CHECKING_NEW_VERSION);

        esp_err_t err = ota_->CheckVersion();
        if (err != ESP_OK) {
            retry_count++;
            if (retry_count >= MAX_RETRY) {
                ESP_LOGE(TAG, "Too many retries, exit version check");
                return;
            }

            char error_message[128];
            snprintf(error_message, sizeof(error_message), "code=%d, url=%s", err,
                     ota_->GetCheckVersionUrl().c_str());
            char buffer[256];
            snprintf(buffer, sizeof(buffer), Lang::Strings::CHECK_NEW_VERSION_FAILED, retry_delay,
                     error_message);
            // Sin sonido: chequear versión no es algo que el usuario pidió, y
            // pitar en cada arranque sin internet molesta más de lo que informa.
            Alert(Lang::Strings::ERROR, buffer, "cloud_off", "");

            ESP_LOGW(TAG, "Check new version failed, retry in %d seconds (%d/%d)", retry_delay,
                     retry_count, MAX_RETRY);
            for (int i = 0; i < retry_delay; i++) {
                vTaskDelay(pdMS_TO_TICKS(1000));
                if (GetDeviceState() == kDeviceStateIdle) {
                    break;
                }
            }
            retry_delay *= 2;  // Double the retry delay
            continue;
        }
        retry_count = 0;
        retry_delay = 10;  // Reset retry delay

        if (ota_->HasNewVersion()) {
            if (UpgradeFirmware(ota_->GetFirmwareUrl(), ota_->GetFirmwareVersion())) {
                return;  // This line will never be reached after reboot
            }
            // If upgrade failed, continue to normal operation
        }

        // No new version, mark the current version as valid
        ota_->MarkCurrentVersionValid();
        if (!ota_->HasActivationCode() && !ota_->HasActivationChallenge()) {
            // Exit the loop if done checking new version
            break;
        }

        display->SetStatus(Lang::Strings::ACTIVATION);
        // Activation code is shown to the user and waiting for the user to input
        if (ota_->HasActivationCode()) {
            ShowActivationCode(ota_->GetActivationCode(), ota_->GetActivationMessage());
        }

        // This will block the loop until the activation is done or timeout
        for (int i = 0; i < 10; ++i) {
            ESP_LOGI(TAG, "Activating... %d/%d", i + 1, 10);
            esp_err_t err = ota_->Activate();
            if (err == ESP_OK) {
                break;
            } else if (err == ESP_ERR_TIMEOUT) {
                vTaskDelay(pdMS_TO_TICKS(3000));
            } else {
                vTaskDelay(pdMS_TO_TICKS(10000));
            }
            if (GetDeviceState() == kDeviceStateIdle) {
                break;
            }
        }
    }
}

void Application::InitializeProtocol() {
    auto& board = Board::GetInstance();
    auto display = board.GetDisplay();
    auto codec = board.GetAudioCodec();

    display->SetStatus(Lang::Strings::LOADING_PROTOCOL);

    // Apollo is configured from NVS, not from an OTA config response. The
    // upstream MQTT/websocket protocols are gone from this fork: Apollo's
    // dialect is the only one the device speaks.
    protocol_ = std::make_unique<ApolloProtocol>();

    protocol_->OnConnected([this]() { DismissAlert(); });

    protocol_->OnNetworkError([this](const std::string& message) {
        last_error_message_ = message;
        xEventGroupSetBits(event_group_, MAIN_EVENT_ERROR);
    });

    protocol_->OnIncomingAudio([this](std::unique_ptr<AudioStreamPacket> packet) {
        if (GetDeviceState() == kDeviceStateSpeaking) {
            audio_service_.PushPacketToDecodeQueue(std::move(packet));
        }
    });

    protocol_->OnAudioChannelOpened([this, codec, &board]() {
        board.SetPowerSaveLevel(PowerSaveLevel::PERFORMANCE);
        if (protocol_->server_sample_rate() != codec->output_sample_rate()) {
            ESP_LOGW(TAG,
                     "Server sample rate %d does not match device output sample rate %d, "
                     "resampling may cause distortion",
                     protocol_->server_sample_rate(), codec->output_sample_rate());
        }
    });

    protocol_->OnAudioChannelClosed([this, &board]() {
        board.SetPowerSaveLevel(PowerSaveLevel::LOW_POWER);
        // A confirmation cannot be answered over a closed channel, and the
        // server-side expiry that would clear the screen can no longer arrive.
        DismissConfirm();
        Schedule([this]() {
            auto display = Board::GetInstance().GetDisplay();
            display->SetChatMessage("system", "");
            SetDeviceState(kDeviceStateIdle);
        });
    });

    protocol_->OnIncomingJson([this, display](const cJSON* root) {
        // Parse JSON data
        auto type = cJSON_GetObjectItem(root, "type");
        if (!cJSON_IsString(type)) {
            ESP_LOGW(TAG, "Incoming JSON message has no type");
            return;
        }
        if (strcmp(type->valuestring, "tts") == 0) {
            auto state = cJSON_GetObjectItem(root, "state");
            if (!cJSON_IsString(state)) {
                return;
            }
            if (strcmp(state->valuestring, "start") == 0) {
                Schedule([this]() {
                    aborted_ = false;
                    audio_service_.ResetPlayedTtsMilliseconds();
                    SetDeviceState(kDeviceStateSpeaking);
                });
            } else if (strcmp(state->valuestring, "stop") == 0) {
                Schedule([this]() {
                    if (GetDeviceState() != kDeviceStateSpeaking) {
                        return;
                    }
#ifdef CONFIG_APOLLO_PROTOCOL
                    // Apollo pushes the whole reply as fast as the link allows,
                    // so "stop" means "that was the last byte", not "playback is
                    // over" — a 7 second reply arrives in about one. Leaving
                    // speaking here would drop the face back to idle mid
                    // sentence, so wait for the playback queue to drain.
                    if (!audio_service_.IsPlaybackIdle()) {
                        pending_speech_stop_ = true;
                        return;
                    }
#endif
                    FinishSpeaking();
                });
            } else if (strcmp(state->valuestring, "sentence_start") == 0) {
                auto text = cJSON_GetObjectItem(root, "text");
                if (cJSON_IsString(text)) {
                    std::vector<TextGlyph> glyphs;
                    uint8_t bpp = 0;
                    if (!TextGlyphPayload::Parse(root, glyphs, bpp)) {
                        glyphs.clear();
                    }
                    ESP_LOGI(TAG, "<< %s", text->valuestring);
                    Schedule([display, message = std::string(text->valuestring),
                              glyphs = std::move(glyphs), bpp]() {
                        display->AddTextGlyphs(glyphs, bpp);
                        display->SetChatMessage("assistant", message.c_str());
                    });
                }
            }
        } else if (strcmp(type->valuestring, "stt") == 0) {
            auto text = cJSON_GetObjectItem(root, "text");
            if (cJSON_IsString(text)) {
                std::vector<TextGlyph> glyphs;
                uint8_t bpp = 0;
                if (!TextGlyphPayload::Parse(root, glyphs, bpp)) {
                    glyphs.clear();
                }
                ESP_LOGI(TAG, ">> %s", text->valuestring);
                Schedule([display, message = std::string(text->valuestring),
                          glyphs = std::move(glyphs), bpp]() {
                    display->AddTextGlyphs(glyphs, bpp);
                    display->SetChatMessage("user", message.c_str());
                });
            }
        } else if (strcmp(type->valuestring, "llm") == 0) {
            auto emotion = cJSON_GetObjectItem(root, "emotion");
            if (cJSON_IsString(emotion)) {
                Schedule([display, emotion_str = std::string(emotion->valuestring)]() {
                    display->SetEmotion(emotion_str.c_str());
                });
            }
        } else if (strcmp(type->valuestring, "accent") == 0) {
            auto color = cJSON_GetObjectItem(root, "color");
            if (cJSON_IsString(color)) {
                Schedule([display, color_str = std::string(color->valuestring)]() {
                    display->SetAccentColor(color_str.c_str());
                });
            }
        } else if (strcmp(type->valuestring, "arc") == 0) {
            auto started_at = cJSON_GetObjectItem(root, "startedAtMs");
            auto ends_at = cJSON_GetObjectItem(root, "endsAtMs");
            if (cJSON_IsNumber(started_at) && cJSON_IsNumber(ends_at)) {
                Schedule([display, started_at_ms = (int64_t)started_at->valuedouble,
                          ends_at_ms = (int64_t)ends_at->valuedouble]() {
                    display->SetAccentRingProgress(started_at_ms, ends_at_ms);
                });
            } else {
                Schedule([display]() { display->ClearAccentRingProgress(); });
            }
        } else if (strcmp(type->valuestring, "mcp") == 0) {
            auto payload = cJSON_GetObjectItem(root, "payload");
            if (cJSON_IsObject(payload)) {
                McpServer::GetInstance().ParseMessage(payload);
            }
        } else if (strcmp(type->valuestring, "system") == 0) {
            auto command = cJSON_GetObjectItem(root, "command");
            if (cJSON_IsString(command)) {
                ESP_LOGI(TAG, "System command: %s", command->valuestring);
                if (strcmp(command->valuestring, "reboot") == 0) {
                    // Do a reboot if user requests a OTA update
                    Schedule([this]() { Reboot(); });
                } else {
                    ESP_LOGW(TAG, "Unknown system command: %s", command->valuestring);
                }
            }
        } else if (strcmp(type->valuestring, "alert") == 0) {
            auto status = cJSON_GetObjectItem(root, "status");
            auto message = cJSON_GetObjectItem(root, "message");
            auto emotion = cJSON_GetObjectItem(root, "emotion");
            if (cJSON_IsString(status) && cJSON_IsString(message) && cJSON_IsString(emotion)) {
                Alert(status->valuestring, message->valuestring, emotion->valuestring,
                      Lang::Sounds::OGG_VIBRATION);
            } else {
                ESP_LOGW(TAG, "Alert command requires status, message and emotion");
            }
#if CONFIG_RECEIVE_CUSTOM_MESSAGE
        } else if (strcmp(type->valuestring, "custom") == 0) {
            auto payload = cJSON_GetObjectItem(root, "payload");
            ESP_LOGI(TAG, "Received custom message: %s", cJSON_PrintUnformatted(root));
            if (cJSON_IsObject(payload)) {
                Schedule(
                    [this, display, payload_str = std::string(cJSON_PrintUnformatted(payload))]() {
                        display->SetChatMessage("system", payload_str.c_str());
                    });
            } else {
                ESP_LOGW(TAG, "Invalid custom message format: missing payload");
            }
#endif
        } else {
            ESP_LOGW(TAG, "Unknown message type: %s", type->valuestring);
        }
    });

    protocol_->Start();
}

void Application::ShowActivationCode(const std::string& code, const std::string& message) {
    struct digit_sound {
        char digit;
        const std::string_view& sound;
    };
    static const std::array<digit_sound, 10> digit_sounds{
        {digit_sound{'0', Lang::Sounds::OGG_0}, digit_sound{'1', Lang::Sounds::OGG_1},
         digit_sound{'2', Lang::Sounds::OGG_2}, digit_sound{'3', Lang::Sounds::OGG_3},
         digit_sound{'4', Lang::Sounds::OGG_4}, digit_sound{'5', Lang::Sounds::OGG_5},
         digit_sound{'6', Lang::Sounds::OGG_6}, digit_sound{'7', Lang::Sounds::OGG_7},
         digit_sound{'8', Lang::Sounds::OGG_8}, digit_sound{'9', Lang::Sounds::OGG_9}}};

    // This sentence uses 9KB of SRAM, so we need to wait for it to finish
    Alert(Lang::Strings::ACTIVATION, message.c_str(), "link", Lang::Sounds::OGG_ACTIVATION);

    for (const auto& digit : code) {
        auto it = std::find_if(digit_sounds.begin(), digit_sounds.end(),
                               [digit](const digit_sound& ds) { return ds.digit == digit; });
        if (it != digit_sounds.end()) {
            audio_service_.PlaySound(it->sound);
        }
    }
}

void Application::Alert(const char* status, const char* message, const char* emotion,
                        const std::string_view& sound) {
    ESP_LOGW(TAG, "Alert [%s] %s: %s", emotion, status, message);
    auto display = Board::GetInstance().GetDisplay();
    display->SetStatus(status);
    display->SetEmotion(emotion);
    display->SetChatMessage("system", message);
    if (!sound.empty()) {
        audio_service_.PlaySound(sound);
    }
}

void Application::DismissAlert() {
    if (GetDeviceState() == kDeviceStateIdle) {
        auto display = Board::GetInstance().GetDisplay();
        display->SetStatus(Lang::Strings::STANDBY);
        display->SetEmotion("neutral");
        display->SetChatMessage("system", "");
    }
}

void Application::ToggleChatState() { xEventGroupSetBits(event_group_, MAIN_EVENT_TOGGLE_CHAT); }

void Application::StartListening() { xEventGroupSetBits(event_group_, MAIN_EVENT_START_LISTENING); }

void Application::StopListening() { xEventGroupSetBits(event_group_, MAIN_EVENT_STOP_LISTENING); }

void Application::HandleToggleChatEvent() {
    auto state = GetDeviceState();

    if (state == kDeviceStateActivating) {
        SetDeviceState(kDeviceStateIdle);
        return;
    } else if (state == kDeviceStateWifiConfiguring) {
        audio_service_.EnableAudioTesting(true);
        SetDeviceState(kDeviceStateAudioTesting);
        return;
    } else if (state == kDeviceStateAudioTesting) {
        audio_service_.EnableAudioTesting(false);
        SetDeviceState(kDeviceStateWifiConfiguring);
        return;
    }

    if (!protocol_) {
        ESP_LOGE(TAG, "Protocol not initialized");
        return;
    }

    if (state == kDeviceStateIdle) {
        ListeningMode mode = GetDefaultListeningMode();
        if (!protocol_->IsAudioChannelOpened()) {
            SetDeviceState(kDeviceStateConnecting);
            // Schedule to let the state change be processed first (UI update)
            Schedule([this, mode]() { ContinueOpenAudioChannel(mode); });
            return;
        }
        SetListeningMode(mode);
    } else if (state == kDeviceStateSpeaking) {
        AbortSpeaking(kAbortReasonNone);
    } else if (state == kDeviceStateListening) {
        protocol_->CloseAudioChannel();
    }
}

void Application::ContinueOpenAudioChannel(ListeningMode mode) {
    // Check state again in case it was changed during scheduling
    if (GetDeviceState() != kDeviceStateConnecting) {
        return;
    }

    // Switch to performance mode before connecting to reduce latency
    auto& board = Board::GetInstance();
    board.SetPowerSaveLevel(PowerSaveLevel::PERFORMANCE);

    if (!protocol_->IsAudioChannelOpened()) {
        if (!protocol_->OpenAudioChannel()) {
            // Return to idle so the device is not stuck in the connecting
            // state (not every failure path reports a network error)
            SetDeviceState(kDeviceStateIdle);
            return;
        }
    }

    SetListeningMode(mode);
}

void Application::HandleStartListeningEvent() {
    auto state = GetDeviceState();

    if (state == kDeviceStateActivating) {
        SetDeviceState(kDeviceStateIdle);
        return;
    } else if (state == kDeviceStateWifiConfiguring) {
        audio_service_.EnableAudioTesting(true);
        SetDeviceState(kDeviceStateAudioTesting);
        return;
    }

    if (!protocol_) {
        ESP_LOGE(TAG, "Protocol not initialized");
        return;
    }

    if (state == kDeviceStateIdle) {
        if (!protocol_->IsAudioChannelOpened()) {
            SetDeviceState(kDeviceStateConnecting);
            // Schedule to let the state change be processed first (UI update)
            Schedule([this]() { ContinueOpenAudioChannel(kListeningModeManualStop); });
            return;
        }
        SetListeningMode(kListeningModeManualStop);
    } else if (state == kDeviceStateSpeaking) {
        AbortSpeaking(kAbortReasonNone);
        SetListeningMode(kListeningModeManualStop);
    }
}

#ifdef CONFIG_APOLLO_PROTOCOL
void Application::InitializeSystemTime() {
    // Fire and forget: the clock is only used for the on-screen display, so
    // nothing here should delay reaching the idle state.
    setenv("TZ", CONFIG_APOLLO_TIMEZONE, 1);
    tzset();

    esp_sntp_config_t sntp_config = ESP_NETIF_SNTP_DEFAULT_CONFIG(CONFIG_APOLLO_NTP_SERVER);
    sntp_config.start = true;
    sntp_config.server_from_dhcp = false;
    auto err = esp_netif_sntp_init(&sntp_config);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "SNTP init failed: %s", esp_err_to_name(err));
        return;
    }
    ESP_LOGI(TAG, "SNTP started against %s (TZ %s)", CONFIG_APOLLO_NTP_SERVER,
             CONFIG_APOLLO_TIMEZONE);
}
#endif

void Application::SleepScreen() {
    if (is_screen_asleep_) {
        return;
    }
    is_screen_asleep_ = true;
    ESP_LOGI(TAG, "Screen asleep after %d s idle", idle_seconds_);

    auto& board = Board::GetInstance();
    board.GetDisplay()->SetPowerSaveMode(true);
    auto backlight = board.GetBacklight();
    if (backlight != nullptr) {
        // Not permanent: the configured brightness has to survive the nap.
        backlight->SetBrightness(0);
    }
}

void Application::NoteUserActivity() {
    idle_seconds_ = 0;
    if (!is_screen_asleep_) {
        return;
    }
    is_screen_asleep_ = false;
    ESP_LOGI(TAG, "Screen awake");

    auto& board = Board::GetInstance();
    auto backlight = board.GetBacklight();
    if (backlight != nullptr) {
        backlight->RestoreBrightness();
    }
    board.GetDisplay()->SetPowerSaveMode(false);
}

void Application::SendGesture(const std::string& gesture) {
    Schedule([this, gesture]() {
        // A touch on a dark screen means "wake up", nothing more: forwarding it
        // would also open the dashboard, which is not what the hand meant.
        const bool was_asleep = is_screen_asleep_;
        NoteUserActivity();
        if (was_asleep) {
            return;
        }

        // Un recordatorio a pantalla completa se lleva el primer toque, sea el
        // gesto que sea. Encaja con lo que un tap ya significa mas abajo: la
        // forma de frenar algo que esta pasando.
        //
        // Va ANTES del chequeo de protocol_: el recordatorio se tiene que poder
        // descartar aunque la conexion con el servidor se haya caido, que es
        // justo cuando peor seria quedarse con la pantalla tomada y sin salida.
        {
            auto* dashboard =
                dynamic_cast<JarvisDashboardDisplay*>(Board::GetInstance().GetDisplay());
            if (dashboard != nullptr && dashboard->IsReminderVisible()) {
                dashboard->DismissReminder();
                // Visto: el servidor ya no lo reenvia por WhatsApp.
                auto* apollo = dynamic_cast<ApolloProtocol*>(protocol_.get());
                if (apollo != nullptr) {
                    apollo->SendReminderSeen();
                }
                return;
            }
        }

        if (!protocol_) {
            return;
        }

        // Recording is on the press-and-hold; a tap is only ever a way to stop
        // something, so it never reaches the server as a gesture.
        if (gesture == "tap") {
            switch (GetDeviceState()) {
                case kDeviceStateSpeaking:
                    AbortSpeaking(kAbortReasonNone);
                    // Telling the server to stop is not enough on its own:
                    // seconds of already-delivered audio are sitting in the
                    // queues and would keep playing over the silence.
                    audio_service_.ResetDecoder();
                    SetDeviceState(kDeviceStateIdle);
                    return;
                case kDeviceStateListening:
                    // A tap on an open mic means "forget it": the buffered
                    // audio is discarded server-side, no turn runs.
                    CancelListening();
                    return;
                default:
                    // Mid-connect or mid-activation: a tap has nothing to toggle.
                    return;
            }
        }
        if (!protocol_->IsAudioChannelOpened() && !protocol_->OpenAudioChannel()) {
            ESP_LOGW(TAG, "Gesture '%s' dropped: no channel", gesture.c_str());
            return;
        }
        protocol_->SendGesture(gesture);
    });
}

void Application::ShowConfirm(const std::string& summary, uint32_t timeout_ms) {
    Schedule([this, summary, timeout_ms]() {
        NoteUserActivity();
        if (confirm_expiry_timer_ == nullptr) {
            const esp_timer_create_args_t timer_args = {
                .callback = [](void* arg) { static_cast<Application*>(arg)->DismissConfirm(); },
                .arg = this,
                .dispatch_method = ESP_TIMER_TASK,
                .name = "confirm_expiry",
                .skip_unhandled_events = true,
            };
            ESP_ERROR_CHECK(esp_timer_create(&timer_args, &confirm_expiry_timer_));
        }
        esp_timer_stop(confirm_expiry_timer_);
        confirm_active_.store(true);
        Board::GetInstance().GetDisplay()->ShowConfirmScreen(summary.c_str());
        ESP_ERROR_CHECK(esp_timer_start_once(confirm_expiry_timer_, (uint64_t)timeout_ms * 1000));
    });
}

bool Application::TakeConfirmSession() {
    if (!confirm_active_.exchange(false)) {
        return false;
    }
    if (confirm_expiry_timer_ != nullptr) {
        esp_timer_stop(confirm_expiry_timer_);
    }
    return true;
}

void Application::DismissConfirm() {
    if (!TakeConfirmSession()) {
        return;
    }
    Schedule([]() { Board::GetInstance().GetDisplay()->HideConfirmScreen(); });
}

void Application::OnConfirmTouchRelease(int x, int y) {
    const bool is_approved = confirm_geometry::IsInsideApproveZone(x, y);
    if (!is_approved && !confirm_geometry::IsInsideRejectZone(x, y)) {
        return;
    }
    if (!TakeConfirmSession()) {
        return;
    }
    Schedule([this, is_approved]() {
        Board::GetInstance().GetDisplay()->HideConfirmScreen();
        // The summary's own TTS is usually still playing; an answer means the
        // user heard enough.
        if (GetDeviceState() == kDeviceStateSpeaking) {
            AbortSpeaking(kAbortReasonNone);
            audio_service_.ResetDecoder();
            SetDeviceState(kDeviceStateIdle);
        }
        if (protocol_ != nullptr) {
            protocol_->SendConfirm(is_approved);
        }
        PlaySound(is_approved ? Lang::Sounds::OGG_SUCCESS : Lang::Sounds::OGG_POPUP);
    });
}

void Application::FinishSpeaking() {
    if (listening_mode_ == kListeningModeManualStop) {
        // An interruption is not a completion, so no cue on abort. In auto
        // mode the listening branch plays its own cue, and this one would be
        // cleared by the decoder reset anyway.
        if (!aborted_) {
            audio_service_.PlaySound(Lang::SoundVariants::SpeechDone());
        }
        SetDeviceState(kDeviceStateIdle);
    } else if (reopen_listening_after_speak_) {
        SetDeviceState(kDeviceStateListening);
    } else {
        // The server's turn_end said the reply expects no answer, so the
        // conversation is over instead of looping back to the microphone.
        SetDeviceState(kDeviceStateIdle);
    }
}

void Application::OnTurnEnd(bool expects_reply) {
    Schedule([this, expects_reply]() {
        reopen_listening_after_speak_ = expects_reply;
        // The no-answer verdict can land while the mic is already open again
        // (short replies drain before turn_end arrives); close it too.
        if (!expects_reply && GetDeviceState() == kDeviceStateListening &&
            listening_mode_ != kListeningModeManualStop) {
            CancelListening();
        }
    });
}

void Application::StartListenWatchdog() {
    if (listening_mode_ != kListeningModeAutoStop &&
        listening_mode_ != kListeningModeRealtime) {
        return;
    }
    if (listen_watchdog_timer_ == nullptr) {
        const esp_timer_create_args_t timer_args = {
            .callback =
                [](void* arg) {
                    auto* app = static_cast<Application*>(arg);
                    xEventGroupSetBits(app->event_group_, MAIN_EVENT_LISTEN_WATCHDOG);
                },
            .arg = this,
            .dispatch_method = ESP_TIMER_TASK,
            .name = "listen_watchdog",
            .skip_unhandled_events = true,
        };
        ESP_ERROR_CHECK(esp_timer_create(&timer_args, &listen_watchdog_timer_));
    }
    listen_started_us_ = esp_timer_get_time();
    listen_watchdog_logged_ = false;
    listen_heard_speech_ = false;
    vad_in_speech_.store(false);
    vad_last_onset_us_.store(0);
    vad_last_offset_us_.store(0);
    esp_timer_stop(listen_watchdog_timer_);
    // 100ms en vez de 250: la granularidad del sondeo se suma al silencio
    // exigido, así que a 250ms el corte podía tardar 850+250=1100ms. El costo es
    // despreciable (una comparación de enteros cada 100ms).
    ESP_ERROR_CHECK(esp_timer_start_periodic(listen_watchdog_timer_, 100 * 1000));
}

void Application::HandleListenWatchdogEvent() {
    // El watchdog corre en TODOS los modos de escucha. Antes se limitaba a
    // AutoStop y nadie cerraba el turno en los otros dos: en Realtime (el
    // default cuando hay AEC) y en ManualStop (tocar/mantener la pantalla) el
    // micrófono quedaba abierto indefinidamente.
    if (GetDeviceState() != kDeviceStateListening) {
        return;
    }

    // Una sola vez por sesión, para poder diagnosticar sin adivinar el modo.
    if (!listen_watchdog_logged_) {
        listen_watchdog_logged_ = true;
        ESP_LOGI(TAG, "Listen watchdog running, mode=%d (0=auto 1=manual 2=realtime)",
                 (int)listening_mode_);
    }

    // En ManualStop manda el dedo del usuario: cortar por silencio rompería
    // "mantener apretado mientras pienso". Solo una red de seguridad larga por
    // si el evento de soltar se pierde.
    if (listening_mode_ == kListeningModeManualStop) {
        constexpr int64_t kManualStopSafetyUs = 30 * 1000 * 1000;
        if (esp_timer_get_time() - listen_started_us_ >= kManualStopSafetyUs) {
            ESP_LOGW(TAG, "Manual listen ran 30s without a release, committing the turn");
            StopListening();
        }
        return;
    }
    // No AEC runs while listening, so the ListenStart cue registers on the VAD
    // as speech; activity inside the grace window is the device hearing itself.
    // Con AEC el dispositivo no se escucha a sí mismo, así que el tono de inicio
    // no contamina el VAD y la gracia puede ser mínima.
    const int64_t kCueGraceUs =
        (listening_mode_ == kListeningModeRealtime) ? 200 * 1000 : 700 * 1000;
    constexpr int64_t kMinSpeechUs = 300 * 1000;
    // 1200ms era conservador para placas sin AEC, donde el VAD se ensucia con
    // el propio parlante. Con AEC el corte de habla es limpio y 850ms alcanza:
    // son 350ms menos de espera en CADA turno, que es lo que más se nota.
    constexpr int64_t kEndpointSilenceUs = 850 * 1000;
    // Counted from mic-open, so after the cue+grace (~0.7 s) the user has
    // about 2.3 s to start talking before the session gives up.
    constexpr int64_t kNoSpeechTimeoutUs = 3000 * 1000;

    const int64_t now = esp_timer_get_time();
    const bool in_speech = vad_in_speech_.load();
    const int64_t onset = vad_last_onset_us_.load();
    const int64_t offset = vad_last_offset_us_.load();
    const int64_t effective_onset = std::max(onset, listen_started_us_ + kCueGraceUs);

    if (onset > 0) {
        const int64_t speech_end = in_speech ? now : offset;
        if (speech_end - effective_onset >= kMinSpeechUs) {
            listen_heard_speech_ = true;
        }
    }

    if (listen_heard_speech_) {
        if (!in_speech && offset > 0 && now - offset >= kEndpointSilenceUs) {
            // Se loguea el retardo real desde el fin del habla: es lo que el
            // usuario percibe como "tarda en arrancar". Incluye el silencio
            // exigido más la granularidad del sondeo del watchdog.
            ESP_LOGI(TAG, "VAD endpoint reached after %lldms of silence, committing the turn",
                     (long long)((now - offset) / 1000));
            StopListening();
        }
    } else if (now - listen_started_us_ >= kNoSpeechTimeoutUs) {
        ESP_LOGI(TAG, "Nothing said, cancelling the listen session");
        CancelListening();
    }
}

void Application::CancelListening() {
    if (GetDeviceState() != kDeviceStateListening) {
        return;
    }
    if (protocol_) {
        protocol_->SendListenCancel();
    }
    SetDeviceState(kDeviceStateIdle);
    audio_service_.PlaySound(Lang::SoundVariants::ListenEnd());
}

void Application::HandleStopListeningEvent() {
    auto state = GetDeviceState();

    if (state == kDeviceStateAudioTesting) {
        audio_service_.EnableAudioTesting(false);
        SetDeviceState(kDeviceStateWifiConfiguring);
        return;
    } else if (state == kDeviceStateListening) {
        // hold_end is what makes the server transcribe, so everything recorded
        // has to be on the wire before it goes out. The tail of an utterance is
        // still working its way through the encoder when the finger lifts, and
        // anything arriving after hold_end is simply not part of the turn.
        if (protocol_) {
            for (int attempt = 0; attempt < kListenFlushAttempts; ++attempt) {
                bool sent_any = false;
                while (auto packet = audio_service_.PopPacketFromSendQueue()) {
                    sent_any = true;
                    if (!protocol_->SendAudio(std::move(packet))) {
                        break;
                    }
                }
                if (!sent_any && attempt > 0) {
                    break;
                }
                vTaskDelay(pdMS_TO_TICKS(kListenFlushWaitMs));
            }
            protocol_->SendStopListening();
        }
        SetDeviceState(kDeviceStateIdle);
        // The idle transition disables voice processing without resetting the
        // decoder, so a cue queued here survives it.
        audio_service_.PlaySound(Lang::SoundVariants::ListenEnd());
    }
}

void Application::HandleWakeWordDetectedEvent() {
#ifdef CONFIG_APOLLO_PROTOCOL
    // Saying the wake word to a dark device should light it up, whatever the
    // rest of this handler decides to do about the turn itself.
    NoteUserActivity();
#endif
    if (!protocol_) {
        return;
    }

    auto state = GetDeviceState();
    auto wake_word = audio_service_.GetLastWakeWord();
    ESP_LOGI(TAG, "Wake word detected: %s (state: %d)", wake_word.c_str(), (int)state);

    if (state == kDeviceStateIdle) {
        BeginWakeWordInvoke(wake_word);
    } else if (state == kDeviceStateSpeaking || state == kDeviceStateListening) {
        AbortSpeaking(kAbortReasonWakeWordDetected);
        // Clear send queue to avoid sending residues to server
        while (audio_service_.PopPacketFromSendQueue())
            ;

        if (state == kDeviceStateListening) {
            protocol_->SendStartListening(GetDefaultListeningMode());
            audio_service_.ResetDecoder();
            audio_service_.PlaySound(Lang::SoundVariants::ListenStart());
            // Re-enable wake word detection as it was stopped by the detection itself
            audio_service_.EnableWakeWordDetection(true);
        } else {
            // Play popup sound and start listening again
            play_popup_on_listening_ = true;
            SetListeningMode(GetDefaultListeningMode());
        }
    } else if (state == kDeviceStateActivating) {
        // Restart the activation check if the wake word is detected during activation
        SetDeviceState(kDeviceStateIdle);
    }
}

void Application::BeginWakeWordInvoke(const std::string& wake_word) {
    // Must run in the main task with the device in idle state
    audio_service_.EncodeWakeWord();

    // Always pass through the connecting state, even if the audio channel is
    // already opened. ContinueWakeWordInvoke() rejects any other state, so
    // skipping this transition would silently drop the wake word invocation.
    if (!SetDeviceState(kDeviceStateConnecting)) {
        // Wake word detection was stopped by the detection itself; restore it
        // so the device does not become unresponsive to wake words.
        audio_service_.EnableWakeWordDetection(true);
        return;
    }

    if (!protocol_->IsAudioChannelOpened()) {
        // Schedule to let the state change be processed first (UI update),
        // then continue with OpenAudioChannel which may block for ~1 second
        Schedule([this, wake_word]() { ContinueWakeWordInvoke(wake_word); });
        return;
    }
    // Channel already opened, continue directly
    ContinueWakeWordInvoke(wake_word);
}

void Application::ContinueWakeWordInvoke(const std::string& wake_word) {
    // Check state again in case it was changed during scheduling
    if (GetDeviceState() != kDeviceStateConnecting) {
        return;
    }

    // Switch to performance mode before connecting to reduce latency
    auto& board = Board::GetInstance();
    board.SetPowerSaveLevel(PowerSaveLevel::PERFORMANCE);

    if (!protocol_->IsAudioChannelOpened()) {
        if (!protocol_->OpenAudioChannel()) {
            // Return to idle so the device is not stuck in the connecting
            // state (not every failure path reports a network error), and
            // wake word detection is re-enabled by the idle state handler.
            SetDeviceState(kDeviceStateIdle);
            return;
        }
    }

    ESP_LOGI(TAG, "Wake word detected: %s", wake_word.c_str());
#if CONFIG_SEND_WAKE_WORD_DATA
    // Encode and send the wake word data to the server
    while (auto packet = audio_service_.PopWakeWordPacket()) {
        protocol_->SendAudio(std::move(packet));
    }
    // Set the chat state to wake word detected
    protocol_->SendWakeWordDetected(wake_word);
    SetListeningMode(GetDefaultListeningMode());
#else
    // Set flag to play popup sound after state changes to listening
    // (PlaySound here would be cleared by ResetDecoder in EnableVoiceProcessing)
    play_popup_on_listening_ = true;
    SetListeningMode(GetDefaultListeningMode());
#endif
}

void Application::HandleStateChangedEvent() {
    DeviceState new_state = state_machine_.GetState();
    clock_ticks_ = 0;
    // Any state change invalidates a pending deferred listening start;
    // the Listening case below re-arms it when needed.
    pending_listening_start_ = false;
    // The watchdog only polices an open auto-mode mic; StartListeningAudio
    // re-arms it when the mic actually opens.
    if (listen_watchdog_timer_ != nullptr) {
        esp_timer_stop(listen_watchdog_timer_);
    }

    auto& board = Board::GetInstance();
    auto display = board.GetDisplay();
    auto led = board.GetLed();
    led->OnStateChanged();

    switch (new_state) {
        case kDeviceStateUnknown:
        case kDeviceStateIdle:
            display->SetStatus(Lang::Strings::STANDBY);
            display->ClearChatMessages();    // Clear messages first
            display->SetEmotion("neutral");  // Then set emotion (wechat mode checks child count)
            audio_service_.EnableVoiceProcessing(false);
            audio_service_.EnableWakeWordDetection(true);
            break;
        case kDeviceStateConnecting:
            display->SetStatus(Lang::Strings::CONNECTING);
            display->SetEmotion("neutral");
            display->SetChatMessage("system", "");
            break;
        case kDeviceStateListening:
            display->SetStatus(Lang::Strings::LISTENING);
            // SetStatus already raises EMOTE_MGR_EVT_LISTEN, which drives the
            // listen_anim object. Setting a "listening" emotion on top of that
            // replaces the face itself with listen.eaf, which is not a face and
            // reads as an error.
            display->SetEmotion("neutral");

            // Make sure the audio processor is running
            if (play_popup_on_listening_ || !audio_service_.IsAudioProcessorRunning()) {
                // For auto mode, wait for the playback queue to drain before enabling
                // voice processing. This prevents audio truncation when STOP arrives
                // late due to network jitter. Instead of blocking the main loop here,
                // defer the start until MAIN_EVENT_PLAYBACK_DRAINED arrives.
                if (listening_mode_ == kListeningModeAutoStop && !audio_service_.IsPlaybackIdle()) {
                    pending_listening_start_ = true;
                } else {
                    StartListeningAudio();
                }
            } else {
                ConfigureWakeWordForListening();
                // El procesador ya venía corriendo, que es el caso NORMAL en modo
                // Realtime (ahí la voz nunca se apaga). Como StartListeningAudio no
                // corre por esta rama, el watchdog se perdía y nadie cerraba el
                // turno: el micrófono quedaba abierto para siempre.
                StartListenWatchdog();
            }
            break;
        case kDeviceStateSpeaking:
            display->SetStatus(Lang::Strings::SPEAKING);

            if (listening_mode_ != kListeningModeRealtime) {
                audio_service_.EnableVoiceProcessing(false);
                // Only AFE wake word can be detected in speaking mode
                audio_service_.EnableWakeWordDetection(audio_service_.IsAfeWakeWord());
            }
            audio_service_.ResetDecoder();
            break;
        case kDeviceStateWifiConfiguring:
            audio_service_.EnableVoiceProcessing(false);
            audio_service_.EnableWakeWordDetection(false);
            break;
        default:
            // Do nothing
            break;
    }
}

void Application::StartListeningAudio() {
    // Runs in the main loop, either directly from HandleStateChangedEvent or
    // deferred via MAIN_EVENT_PLAYBACK_DRAINED once the playback queue drains.
    if (GetDeviceState() != kDeviceStateListening) {
        return;
    }

    // Send the start listening command
    protocol_->SendStartListening(listening_mode_);
    audio_service_.EnableVoiceProcessing(true);

    ConfigureWakeWordForListening();

    // Every listening start gets the cue, held button or wake word alike. It
    // has to play after ResetDecoder (in EnableVoiceProcessing) or it would be
    // cleared before it sounds.
    play_popup_on_listening_ = false;
    audio_service_.PlaySound(Lang::SoundVariants::ListenStart());

    // Each new listen session starts optimistic; the reply's turn_end says
    // whether the mic reopens after Apollo speaks.
    reopen_listening_after_speak_ = true;
    StartListenWatchdog();
}

void Application::ConfigureWakeWordForListening() {
#ifdef CONFIG_WAKE_WORD_DETECTION_IN_LISTENING
    // Enable wake word detection in listening mode (configured via Kconfig)
    audio_service_.EnableWakeWordDetection(audio_service_.IsAfeWakeWord());
#else
    // Disable wake word detection in listening mode
    audio_service_.EnableWakeWordDetection(false);
#endif
}

void Application::Schedule(std::function<void()>&& callback) {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        main_tasks_.push_back(std::move(callback));
    }
    xEventGroupSetBits(event_group_, MAIN_EVENT_SCHEDULE);
}

void Application::AbortSpeaking(AbortReason reason) {
    ESP_LOGI(TAG, "Abort speaking");
    aborted_ = true;
    if (protocol_) {
        protocol_->SendAbortSpeaking(reason);
    }
}

void Application::SetListeningMode(ListeningMode mode) {
    listening_mode_ = mode;
    SetDeviceState(kDeviceStateListening);
}

ListeningMode Application::GetDefaultListeningMode() const {
    return aec_mode_ == kAecOff ? kListeningModeAutoStop : kListeningModeRealtime;
}

void Application::Reboot() {
    ESP_LOGI(TAG, "Rebooting...");
    // Disconnect the audio channel
    if (protocol_ && protocol_->IsAudioChannelOpened()) {
        protocol_->CloseAudioChannel();
    }
    protocol_.reset();
    audio_service_.Stop();

    vTaskDelay(pdMS_TO_TICKS(1000));
    esp_restart();
}

bool Application::UpgradeFirmware(const std::string& url, const std::string& version) {
    auto& board = Board::GetInstance();
    auto display = board.GetDisplay();

    std::string upgrade_url = url;
    std::string version_info = version.empty() ? "(Manual upgrade)" : version;

    // Close audio channel if it's open
    if (protocol_ && protocol_->IsAudioChannelOpened()) {
        ESP_LOGI(TAG, "Closing audio channel before firmware upgrade");
        protocol_->CloseAudioChannel();
    }
    ESP_LOGI(TAG, "Starting firmware upgrade from URL: %s", upgrade_url.c_str());

    Alert(Lang::Strings::OTA_UPGRADE, Lang::Strings::UPGRADING, "download",
          Lang::Sounds::OGG_UPGRADE);
    vTaskDelay(pdMS_TO_TICKS(3000));

    SetDeviceState(kDeviceStateUpgrading);

    std::string message = std::string(Lang::Strings::NEW_VERSION) + version_info;
    display->SetChatMessage("system", message.c_str());

    board.SetPowerSaveLevel(PowerSaveLevel::PERFORMANCE);
    audio_service_.Stop();
    vTaskDelay(pdMS_TO_TICKS(1000));

    bool upgrade_success = Ota::Upgrade(upgrade_url, [this, display](int progress, size_t speed) {
        char buffer[32];
        snprintf(buffer, sizeof(buffer), "%d%% %uKB/s", progress, speed / 1024);
        Schedule([display, message = std::string(buffer)]() {
            display->SetChatMessage("system", message.c_str());
        });
    });

    if (!upgrade_success) {
        // Upgrade failed, restart audio service and continue running
        ESP_LOGE(TAG,
                 "Firmware upgrade failed, restarting audio service and continuing operation...");
        audio_service_.Start();                              // Restart audio service
        board.SetPowerSaveLevel(PowerSaveLevel::LOW_POWER);  // Restore power save level
        Alert(Lang::Strings::ERROR, Lang::Strings::UPGRADE_FAILED, "cancel",
              Lang::Sounds::OGG_EXCLAMATION);
        vTaskDelay(pdMS_TO_TICKS(3000));
        return false;
    } else {
        // Upgrade success, reboot immediately
        ESP_LOGI(TAG, "Firmware upgrade successful, rebooting...");
        display->SetChatMessage("system", "Upgrade successful, rebooting...");
        vTaskDelay(pdMS_TO_TICKS(1000));  // Brief pause to show message
        Reboot();
        return true;
    }
}

void Application::WakeWordInvoke(const std::string& wake_word) {
    if (!protocol_) {
        return;
    }

    auto state = GetDeviceState();

    if (state == kDeviceStateIdle) {
        // May be called from outside the main task (e.g. board button
        // callbacks), so schedule the invocation instead of running it here
        Schedule([this, wake_word]() {
            if (GetDeviceState() == kDeviceStateIdle) {
                BeginWakeWordInvoke(wake_word);
            }
        });
    } else if (state == kDeviceStateSpeaking) {
        Schedule([this]() { AbortSpeaking(kAbortReasonNone); });
    } else if (state == kDeviceStateListening) {
        Schedule([this]() {
            if (protocol_) {
                protocol_->CloseAudioChannel();
            }
        });
    }
}

bool Application::CanEnterSleepMode() {
    if (GetDeviceState() != kDeviceStateIdle) {
        return false;
    }

    if (protocol_ && protocol_->IsAudioChannelOpened()) {
        return false;
    }

    if (!audio_service_.IsIdle()) {
        return false;
    }

    // Now it is safe to enter sleep mode
    return true;
}

void Application::RegisterMcpBroadcastCallback(std::function<void(const std::string&)> callback) {
    mcp_broadcast_callback_ = std::move(callback);
}

void Application::SendMcpMessage(const std::string& payload) {
    // Always schedule to run in main task for thread safety
    Schedule([this, payload]() {
        if (protocol_) {
            protocol_->SendMcpMessage(payload);
        }
        if (mcp_broadcast_callback_) {
            mcp_broadcast_callback_(payload);
        }
    });
}

void Application::SetAecMode(AecMode mode) {
    aec_mode_ = mode;
    Schedule([this]() {
        auto& board = Board::GetInstance();
        auto display = board.GetDisplay();
        switch (aec_mode_) {
            case kAecOff:
                audio_service_.EnableDeviceAec(false);
                display->ShowNotification(Lang::Strings::RTC_MODE_OFF);
                break;
            case kAecOnServerSide:
                audio_service_.EnableDeviceAec(false);
                display->ShowNotification(Lang::Strings::RTC_MODE_ON);
                break;
            case kAecOnDeviceSide:
                audio_service_.EnableDeviceAec(true);
                display->ShowNotification(Lang::Strings::RTC_MODE_ON);
                break;
        }

        // If the AEC mode is changed, close the audio channel
        if (protocol_ && protocol_->IsAudioChannelOpened()) {
            protocol_->CloseAudioChannel();
        }
    });
}

void Application::PlaySound(const std::string_view& sound) { audio_service_.PlaySound(sound); }

void Application::ResetProtocol() {
    Schedule([this]() {
        // Close audio channel if opened
        if (protocol_ && protocol_->IsAudioChannelOpened()) {
            protocol_->CloseAudioChannel();
        }
        // Reset protocol
        protocol_.reset();
    });
}
