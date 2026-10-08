#ifndef JARVIS_DASHBOARD_DISPLAY_H
#define JARVIS_DASHBOARD_DISPLAY_H

#include "lcd_display.h"

#include <esp_timer.h>

#include <string>
#include <vector>


// Tablero informativo para la pantalla de 800x480.
//
// Reemplaza la UI de chat de LcdDisplay: en vez de una burbuja de conversacion
// con la cara de fondo, un tablero con una tarjeta por dato. El reparto es el
// que se aprobo sobre la maqueta ("opcion A"):
//
//   +------------------------------------------------+
//   | 21:04   jue 6 sep                 wifi  82%     |
//   +----------------+---------------+---------------+
//   | AGENDA         | PENDIENTES  4 |   (Einstein)  |
//   | Reunion Nico   | - Mejorar UI  |               |
//   | en 40 minutos  | - Scheduler   |   escuchando  |
//   |                | - Localhost   +---------------+
//   | 8 grados       | - MCPs        | AL CENTRO     |
//   | Nublado        |               |   24 min      |
//   +----------------+---------------+---------------+
//
// Los datos llegan en el mensaje `dashboard` del protocolo, ya recortados por
// el servidor: aca solo se dibujan.
class JarvisDashboardDisplay : public RgbLcdDisplay {
public:
    struct AgendaEntry {
        std::string title;
        std::string when_label;
    };

    struct DashboardData {
        // "Trajo la clave" es distinto de "la clave vino vacia". Hay DOS
        // emisores del mensaje `dashboard`: el de upstream manda solo reloj y
        // clima cada 30 min, y sin esta distincion borraba la agenda y los
        // pendientes cada vez que pasaba.
        bool weather_present = false;
        bool agenda_present = false;
        bool pending_present = false;
        bool travel_present = false;

        bool has_weather = false;
        int temperature_c = 0;
        std::string condition_label;
        std::string place_label;

        std::vector<AgendaEntry> agenda_list;

        bool has_pending = false;
        int pending_count = 0;
        std::vector<std::string> pending_item_list;

        bool has_travel = false;
        std::string travel_label;
        int travel_minutes = 0;
    };

    JarvisDashboardDisplay(esp_lcd_panel_io_handle_t panel_io, esp_lcd_panel_handle_t panel,
                           int width, int height, int offset_x, int offset_y, bool mirror_x,
                           bool mirror_y, bool swap_xy);

    virtual void SetupUI() override;
    virtual void SetChatMessage(const char* role, const char* content) override;
    virtual void SetEmotion(const char* emotion) override;
    virtual void SetPowerSaveMode(bool on) override;
    // Animo de la respuesta que manda el servidor ("festejo", "triste",
    // "apurado", "pensativo" o vacio). Se usa mientras Jarvis habla.
    void SetMood(const char* mood);
    virtual void SetAccentColor(const char* color) override;
    virtual void SetTheme(Theme* theme) override;

    // Aplica el ultimo mensaje `dashboard` recibido del servidor.
    void SetDashboardData(const DashboardData& data);

    // Recordatorio a pantalla completa.
    //
    // Es lo contrario de ShowNotification, que se borra sola a los 3 segundos:
    // esto SE QUEDA hasta que alguien lo descarte. Un recordatorio que se
    // desvanece mientras estas en otra habitacion no es un recordatorio.
    //
    // Antes el aviso entraba por SetChatMessage, o sea el globito del Einstein:
    // una linea chica, igual a cualquier frase suelta, que ademas pisaba el
    // mensaje siguiente. Se disparaba bien y no se percibia.
    void ShowReminder(const char* message);
    void DismissReminder();
    bool IsReminderVisible();

private:
    void BuildStatusBar(lv_obj_t* parent);
    void BuildAgendaColumn(lv_obj_t* parent);
    void BuildPendingColumn(lv_obj_t* parent);
    void BuildPetColumn(lv_obj_t* parent);

    lv_obj_t* MakeTile(lv_obj_t* parent, lv_color_t accent, const char* heading);
    void RefreshClockLabel();
    void BuildReminderOverlay(lv_obj_t* parent);

    // Sprite de Einstein: un modo por estado de Jarvis, y los modos de
    // reaccion que el animo de la respuesta elige mientras habla.
    enum class PetMode { kIdle, kListening, kThinking, kTalking };
    enum class PetMood { kNone, kCelebrate, kSad, kHurry, kPensive };
    struct PetAnimation;
    void LoadPetFrames();
    void PlayPetMode(PetMode mode);
    void PlayPetAnimation(PetAnimation* animation, uint32_t repeat_count);
    PetAnimation* AnimationForTalking();

    // Vida en reposo: quieto con parpadeos al azar, un gesto cada tanto y un
    // paseo fuera de la tarjeta cada varios minutos. Corre en un lv_timer, o
    // sea dentro de la tarea de LVGL con el lock ya tomado.
    enum class IdleAct { kRest, kBlink, kGesture, kWalkOut, kWalkIn };
    static void OnIdleLifeTimer(lv_timer_t* timer);
    void TickIdleLife();
    void ShowPetStill(const PetAnimation& animation, int frame_index);
    void StartIdleRest();
    void StartWalk(bool walking_out);
    uint32_t RandomBetween(uint32_t low, uint32_t high);

    // Barra superior
    lv_obj_t* clock_label_ = nullptr;
    lv_obj_t* date_label_ = nullptr;

    // Tarjetas
    // Las filas se crean UNA VEZ y despues solo se les cambia el texto. Antes
    // se hacia lv_obj_clean + recrear en cada actualizacion: el flex recalculaba
    // todo el arbol, las cajas saltaban y parpadeaban, y el animimg aparecia un
    // frame en el centro antes de que el layout se acomodara.
    static constexpr int kAgendaSlotCount = 2;
    static constexpr int kPendingSlotCount = 4;
    lv_obj_t* agenda_body_ = nullptr;
    lv_obj_t* agenda_title_list_[kAgendaSlotCount] = {};
    lv_obj_t* agenda_when_list_[kAgendaSlotCount] = {};
    lv_obj_t* pending_row_list_[kPendingSlotCount] = {};
    lv_obj_t* weather_temp_label_ = nullptr;
    lv_obj_t* weather_cond_label_ = nullptr;
    lv_obj_t* weather_place_label_ = nullptr;
    lv_obj_t* pending_count_label_ = nullptr;
    lv_obj_t* pending_body_ = nullptr;
    lv_obj_t* travel_head_label_ = nullptr;
    lv_obj_t* travel_value_label_ = nullptr;

    // Columna de la mascota
    lv_obj_t* pet_tile_ = nullptr;
    lv_obj_t* pet_anim_ = nullptr;
    lv_obj_t* pet_state_label_ = nullptr;
    lv_obj_t* pet_say_label_ = nullptr;

    // Los descriptores tienen que sobrevivir mientras el animimg los use: LVGL
    // guarda el puntero al arreglo, no una copia.
    struct PetAnimation {
        // Los descriptores se arman a mano en vez de usar LvglCBinImage: ese
        // envuelve otro formato ("cbin"), no el .bin que genera LVGLImage.py.
        // Ademas asi nada intenta liberar memoria que esta MAPEADA A FLASH.
        std::vector<lv_img_dsc_t> descriptor_list;
        std::vector<const void*> source_list;
        uint32_t duration_ms = 1000;
    };
    PetAnimation pet_idle_, pet_listening_, pet_thinking_, pet_talking_;
    PetAnimation pet_jump_, pet_fail_, pet_run_, pet_run_right_;
    PetMode pet_mode_ = PetMode::kIdle;
    PetMood pet_mood_ = PetMood::kNone;

    lv_timer_t* idle_life_timer_ = nullptr;
    IdleAct idle_act_ = IdleAct::kRest;
    uint32_t idle_act_ends_at_ms_ = 0;
    uint32_t next_blink_at_ms_ = 0;
    uint32_t next_gesture_at_ms_ = 0;
    uint32_t next_walk_at_ms_ = 0;
    int blinks_left_ = 0;
    bool asleep_ = false;

    // Recordatorio a pantalla completa. Vive colgado de `screen`, no del
    // container_, para quedar POR ENCIMA del tablero en vez de competir por un
    // lugar en el flex.
    lv_obj_t* reminder_overlay_ = nullptr;
    lv_obj_t* reminder_message_label_ = nullptr;

    // El reloj lo dibuja la placa con su propio RTC: el servidor no tiene por
    // que mandar la hora cuatro veces por minuto solo para que avance.
    esp_timer_handle_t clock_timer_ = nullptr;
    lv_color_t accent_color_;
};

#endif  // JARVIS_DASHBOARD_DISPLAY_H
