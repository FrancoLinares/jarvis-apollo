#include "jarvis_dashboard_display.h"

// lcd_display.h no arrastra el tema: LvglTheme vive en su propio header, igual
// que lo incluye lcd_display.cc.
#include "lvgl_theme.h"
#include "assets/lang_config.h"
#include "assets.h"

#include <esp_log.h>
#include <esp_random.h>
#include <esp_timer.h>
#include <time.h>

#include <cstdio>
#include <cstring>
#include <memory>
#include <string>

#define TAG "JarvisDashboard"

namespace {

// Paleta del tablero. Son los mismos acentos que usa el servidor por familia de
// herramienta (overrides/turn/caption.ts), para que la pantalla y los carteles
// hablen el mismo idioma de color.
constexpr uint32_t kColorScreen = 0x0B1015;
constexpr uint32_t kColorTile = 0x1B2A33;
constexpr uint32_t kColorTileLine = 0x35505C;
constexpr uint32_t kColorInk = 0xF2F7F6;
constexpr uint32_t kColorDim = 0xA8BFBC;
constexpr uint32_t kColorTurquoise = 0x2DD4BF;  // la respuesta escribiendose
constexpr uint32_t kColorTangerine = 0xF97316;  // agenda y recordatorios
constexpr uint32_t kColorViolet = 0xA855F7;     // memoria y listas
constexpr uint32_t kColorGreen = 0x22C55E;      // lugares y viajes
constexpr uint32_t kColorSky = 0x38BDF8;        // clima

constexpr int kClockTickPeriodMicroseconds = 10 * 1000 * 1000;

// Anchos del reparto aprobado, en pixeles del panel de 800.
constexpr int kAgendaColumnWidth = 262;
constexpr int kPendingColumnWidth = 288;
constexpr int kGap = 9;
constexpr int kOuterPad = 10;
constexpr int kStatusBarHeight = 34;

// Einstein: 150x163, convertido de PicoPixel. Las duraciones son las del propio
// sprite, no inventadas — ver deploy/esp32/assets/einstein/modes.json.
constexpr int kPetFrameWidth = 150;
constexpr int kPetFrameHeight = 163;
constexpr uint32_t kPetIdleDurationMs = 1100;
constexpr uint32_t kPetListeningDurationMs = 1010;
constexpr uint32_t kPetThinkingDurationMs = 1030;
constexpr uint32_t kPetTalkingDurationMs = 700;
// Reacciones (animo de la respuesta) y el paseo: duraciones del propio sprite.
constexpr uint32_t kPetJumpDurationMs = 840;
constexpr uint32_t kPetFailDurationMs = 1060;
constexpr uint32_t kPetRunDurationMs = 820;
constexpr uint32_t kPetRunRightDurationMs = 1060;

// Vida en reposo. El loop de idle del sprite parpadea DOS veces cada 1,1 s, que
// se lee como un tic nervioso: en reposo se muestra quieto (frame 0, ojos
// abiertos) y se parpadea con el frame 1 (ojos cerrados) a intervalos al azar.
constexpr int kPetRestFrame = 0;
constexpr int kPetBlinkFrame = 1;
constexpr uint32_t kIdleLifeTickMs = 100;
constexpr uint32_t kBlinkClosedMs = 140;
constexpr uint32_t kBlinkOpenGapMs = 110;
constexpr uint32_t kBlinkMinGapMs = 2500;
constexpr uint32_t kBlinkMaxGapMs = 7000;
constexpr uint32_t kGestureMinGapMs = 25 * 1000;
constexpr uint32_t kGestureMaxGapMs = 60 * 1000;
constexpr uint32_t kWalkMinGapMs = 4 * 60 * 1000;
constexpr uint32_t kWalkMaxGapMs = 8 * 60 * 1000;
constexpr uint32_t kWalkLegMs = 1800;

void SetPetTranslateX(void* object, int32_t value) {
    lv_obj_set_style_translate_x(static_cast<lv_obj_t*>(object), value, 0);
}
// Cabecera del formato .bin de LVGLImage.py: magic + cf + flags + w + h + stride
// + reservado. Los pixeles arrancan despues.
constexpr size_t kLvglBinHeaderBytes = 12;

const char* kMonthAbbreviationList[] = {"ene", "feb", "mar", "abr", "may", "jun",
                                        "jul", "ago", "sep", "oct", "nov", "dic"};
const char* kWeekdayAbbreviationList[] = {"dom", "lun", "mar", "mie", "jue", "vie", "sab"};

// Solo color: la fuente se HEREDA de la pantalla a proposito.
//
// `Assets::Apply` cambia la fuente de texto al arrancar y LIBERA la anterior.
// Cualquier label con la fuente fijada en su estilo local queda apuntando a
// memoria liberada, y el siguiente layout la desreferencia: crash en
// lv_font_get_glyph_dsc, dentro de la tarea de LVGL. Pasaba con los titulos de
// las tarjetas, que se crean en MakeTile y de los que no se guarda puntero.
//
// Heredando, actualizar la fuente de la pantalla en SetTheme alcanza para todos.
void StyleTileText(lv_obj_t* label, uint32_t color) {
    if (label == nullptr) {
        return;
    }
    lv_obj_set_style_text_color(label, lv_color_hex(color), 0);
}

// El tema no siempre trae cargadas todas las fuentes: con los assets por
// defecto `large_icon_font` viene vacia, y desreferenciarla revienta. Solo
// `text_font` e `icon_font` las usa LcdDisplay sin condicion, asi que son las
// unicas en las que se puede confiar.
const lv_font_t* SafeFont(const std::shared_ptr<LvglFont>& font) {
    return font == nullptr ? nullptr : font->font();
}

}  // namespace

JarvisDashboardDisplay::JarvisDashboardDisplay(esp_lcd_panel_io_handle_t panel_io,
                                               esp_lcd_panel_handle_t panel, int width,
                                               int height, int offset_x, int offset_y,
                                               bool mirror_x, bool mirror_y, bool swap_xy)
    : RgbLcdDisplay(panel_io, panel, width, height, offset_x, offset_y, mirror_x, mirror_y,
                    swap_xy),
      accent_color_(lv_color_hex(kColorTurquoise)) {}

lv_obj_t* JarvisDashboardDisplay::MakeTile(lv_obj_t* parent, lv_color_t accent,
                                           const char* heading) {
    auto lvgl_theme = static_cast<LvglTheme*>(current_theme_);

    lv_obj_t* tile = lv_obj_create(parent);
    lv_obj_set_width(tile, LV_PCT(100));
    lv_obj_set_style_bg_color(tile, lv_color_hex(kColorTile), 0);
    lv_obj_set_style_border_color(tile, lv_color_hex(kColorTileLine), 0);
    lv_obj_set_style_border_width(tile, 1, 0);
    lv_obj_set_style_radius(tile, 9, 0);
    lv_obj_set_style_pad_all(tile, 11, 0);
    lv_obj_set_style_pad_row(tile, 5, 0);
    lv_obj_set_flex_flow(tile, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_scrollbar_mode(tile, LV_SCROLLBAR_MODE_OFF);
    lv_obj_clear_flag(tile, LV_OBJ_FLAG_SCROLLABLE);

    if (heading != nullptr) {
        // Encabezado: un cuadradito del color de la familia mas el rotulo. El
        // color es lo que distingue las tarjetas de un vistazo, ahora que la
        // fuente no dibuja emojis.
        lv_obj_t* head = lv_obj_create(tile);
        lv_obj_set_size(head, LV_PCT(100), LV_SIZE_CONTENT);
        lv_obj_set_style_bg_opa(head, LV_OPA_TRANSP, 0);
        lv_obj_set_style_border_width(head, 0, 0);
        lv_obj_set_style_pad_all(head, 0, 0);
        lv_obj_set_style_pad_column(head, 7, 0);
        lv_obj_set_flex_flow(head, LV_FLEX_FLOW_ROW);
        lv_obj_set_flex_align(head, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER,
                              LV_FLEX_ALIGN_CENTER);
        lv_obj_set_scrollbar_mode(head, LV_SCROLLBAR_MODE_OFF);
        lv_obj_clear_flag(head, LV_OBJ_FLAG_SCROLLABLE);

        lv_obj_t* swatch = lv_obj_create(head);
        lv_obj_set_size(swatch, 7, 7);
        lv_obj_set_style_bg_color(swatch, accent, 0);
        lv_obj_set_style_border_width(swatch, 0, 0);
        lv_obj_set_style_radius(swatch, 2, 0);

        lv_obj_t* title = lv_label_create(head);
        lv_label_set_text(title, heading);
        StyleTileText(title, kColorDim);
    }
    return tile;
}

void JarvisDashboardDisplay::BuildStatusBar(lv_obj_t* parent) {
    auto lvgl_theme = static_cast<LvglTheme*>(current_theme_);
    auto text_font = SafeFont(lvgl_theme->text_font());
    auto icon_font = SafeFont(lvgl_theme->icon_font());

    lv_obj_t* bar = lv_obj_create(parent);
    lv_obj_set_size(bar, LV_PCT(100), kStatusBarHeight);
    lv_obj_set_style_bg_opa(bar, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(bar, 0, 0);
    lv_obj_set_style_pad_all(bar, 0, 0);
    lv_obj_set_style_pad_left(bar, 6, 0);
    lv_obj_set_style_pad_right(bar, 6, 0);
    lv_obj_set_style_pad_column(bar, 12, 0);
    lv_obj_set_flex_flow(bar, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(bar, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER,
                          LV_FLEX_ALIGN_CENTER);
    lv_obj_set_scrollbar_mode(bar, LV_SCROLLBAR_MODE_OFF);
    lv_obj_clear_flag(bar, LV_OBJ_FLAG_SCROLLABLE);

    clock_label_ = lv_label_create(bar);
    StyleTileText(clock_label_, kColorInk);

    date_label_ = lv_label_create(bar);
    StyleTileText(date_label_, kColorDim);

    // Empuja los iconos al extremo derecho sin tener que calcular anchos.
    lv_obj_t* spacer = lv_obj_create(bar);
    lv_obj_set_style_bg_opa(spacer, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(spacer, 0, 0);
    lv_obj_set_height(spacer, 1);
    lv_obj_set_flex_grow(spacer, 1);

    // Los reusa la clase base: son los mismos objetos que actualiza
    // UpdateStatusBar con la señal de wifi y la bateria.
    network_label_ = lv_label_create(bar);
    lv_label_set_text(network_label_, "");
    StyleTileText(network_label_, kColorDim);
    if (icon_font != nullptr) {
        lv_obj_set_style_text_font(network_label_, icon_font, 0);
    }

    mute_label_ = lv_label_create(bar);
    lv_label_set_text(mute_label_, "");
    StyleTileText(mute_label_, kColorDim);
    if (icon_font != nullptr) {
        lv_obj_set_style_text_font(mute_label_, icon_font, 0);
    }

    battery_label_ = lv_label_create(bar);
    lv_label_set_text(battery_label_, "");
    StyleTileText(battery_label_, kColorDim);
    if (icon_font != nullptr) {
        lv_obj_set_style_text_font(battery_label_, icon_font, 0);
    }

    RefreshClockLabel();
}

void JarvisDashboardDisplay::BuildAgendaColumn(lv_obj_t* parent) {
    auto lvgl_theme = static_cast<LvglTheme*>(current_theme_);
    auto text_font = SafeFont(lvgl_theme->text_font());

    lv_obj_t* column = lv_obj_create(parent);
    lv_obj_set_size(column, kAgendaColumnWidth, LV_PCT(100));
    lv_obj_set_style_bg_opa(column, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(column, 0, 0);
    lv_obj_set_style_pad_all(column, 0, 0);
    lv_obj_set_style_pad_row(column, kGap, 0);
    lv_obj_set_flex_flow(column, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_scrollbar_mode(column, LV_SCROLLBAR_MODE_OFF);
    lv_obj_clear_flag(column, LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t* agenda = MakeTile(column, lv_color_hex(kColorTangerine), "AGENDA");
    lv_obj_set_flex_grow(agenda, 1);
    agenda_body_ = lv_obj_create(agenda);
    lv_obj_set_size(agenda_body_, LV_PCT(100), LV_SIZE_CONTENT);
    lv_obj_set_style_bg_opa(agenda_body_, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(agenda_body_, 0, 0);
    lv_obj_set_style_pad_all(agenda_body_, 0, 0);
    lv_obj_set_style_pad_row(agenda_body_, 4, 0);
    lv_obj_set_flex_flow(agenda_body_, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_scrollbar_mode(agenda_body_, LV_SCROLLBAR_MODE_OFF);
    lv_obj_clear_flag(agenda_body_, LV_OBJ_FLAG_SCROLLABLE);

    for (int slot = 0; slot < kAgendaSlotCount; slot++) {
        agenda_title_list_[slot] = lv_label_create(agenda_body_);
        lv_obj_set_width(agenda_title_list_[slot], LV_PCT(100));
        lv_label_set_long_mode(agenda_title_list_[slot], LV_LABEL_LONG_DOT);
        lv_label_set_text(agenda_title_list_[slot], "");
        StyleTileText(agenda_title_list_[slot], kColorInk);
        lv_obj_add_flag(agenda_title_list_[slot], LV_OBJ_FLAG_HIDDEN);

        agenda_when_list_[slot] = lv_label_create(agenda_body_);
        lv_obj_set_width(agenda_when_list_[slot], LV_PCT(100));
        lv_label_set_long_mode(agenda_when_list_[slot], LV_LABEL_LONG_DOT);
        lv_label_set_text(agenda_when_list_[slot], "");
        StyleTileText(agenda_when_list_[slot], kColorTangerine);
        lv_obj_add_flag(agenda_when_list_[slot], LV_OBJ_FLAG_HIDDEN);
    }

    lv_obj_t* weather = MakeTile(column, lv_color_hex(kColorSky), nullptr);
    lv_obj_set_flex_flow(weather, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(weather, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER,
                          LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_column(weather, 14, 0);

    weather_temp_label_ = lv_label_create(weather);
    lv_label_set_text(weather_temp_label_, "--");
    StyleTileText(weather_temp_label_, kColorInk);

    lv_obj_t* meta = lv_obj_create(weather);
    lv_obj_set_size(meta, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    lv_obj_set_style_bg_opa(meta, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(meta, 0, 0);
    lv_obj_set_style_pad_all(meta, 0, 0);
    lv_obj_set_style_pad_row(meta, 1, 0);
    lv_obj_set_flex_flow(meta, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_scrollbar_mode(meta, LV_SCROLLBAR_MODE_OFF);
    lv_obj_clear_flag(meta, LV_OBJ_FLAG_SCROLLABLE);

    weather_cond_label_ = lv_label_create(meta);
    lv_label_set_text(weather_cond_label_, "");
    StyleTileText(weather_cond_label_, kColorInk);

    weather_place_label_ = lv_label_create(meta);
    lv_label_set_text(weather_place_label_, "");
    StyleTileText(weather_place_label_, kColorDim);
}

void JarvisDashboardDisplay::BuildPendingColumn(lv_obj_t* parent) {
    auto lvgl_theme = static_cast<LvglTheme*>(current_theme_);

    lv_obj_t* column = lv_obj_create(parent);
    lv_obj_set_size(column, kPendingColumnWidth, LV_PCT(100));
    lv_obj_set_style_bg_opa(column, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(column, 0, 0);
    lv_obj_set_style_pad_all(column, 0, 0);
    lv_obj_set_flex_flow(column, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_scrollbar_mode(column, LV_SCROLLBAR_MODE_OFF);
    lv_obj_clear_flag(column, LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t* tile = MakeTile(column, lv_color_hex(kColorViolet), "PENDIENTES");
    lv_obj_set_flex_grow(tile, 1);

    // El contador va pegado al encabezado, alineado a la derecha.
    lv_obj_t* head = lv_obj_get_child(tile, 0);
    lv_obj_t* spacer = lv_obj_create(head);
    lv_obj_set_style_bg_opa(spacer, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(spacer, 0, 0);
    lv_obj_set_height(spacer, 1);
    lv_obj_set_flex_grow(spacer, 1);
    pending_count_label_ = lv_label_create(head);
    lv_label_set_text(pending_count_label_, "");
    StyleTileText(pending_count_label_, kColorViolet);

    pending_body_ = lv_obj_create(tile);
    lv_obj_set_size(pending_body_, LV_PCT(100), LV_SIZE_CONTENT);
    lv_obj_set_style_bg_opa(pending_body_, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(pending_body_, 0, 0);
    lv_obj_set_style_pad_all(pending_body_, 0, 0);
    lv_obj_set_style_pad_row(pending_body_, 9, 0);
    lv_obj_set_flex_flow(pending_body_, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_scrollbar_mode(pending_body_, LV_SCROLLBAR_MODE_OFF);
    lv_obj_clear_flag(pending_body_, LV_OBJ_FLAG_SCROLLABLE);

    for (int slot = 0; slot < kPendingSlotCount; slot++) {
        pending_row_list_[slot] = lv_label_create(pending_body_);
        lv_obj_set_width(pending_row_list_[slot], LV_PCT(100));
        lv_label_set_long_mode(pending_row_list_[slot], LV_LABEL_LONG_DOT);
        lv_label_set_text(pending_row_list_[slot], "");
        StyleTileText(pending_row_list_[slot], kColorInk);
        lv_obj_add_flag(pending_row_list_[slot], LV_OBJ_FLAG_HIDDEN);
    }
}

void JarvisDashboardDisplay::BuildPetColumn(lv_obj_t* parent) {
    auto lvgl_theme = static_cast<LvglTheme*>(current_theme_);
    auto text_font = SafeFont(lvgl_theme->text_font());

    lv_obj_t* column = lv_obj_create(parent);
    lv_obj_set_height(column, LV_PCT(100));
    lv_obj_set_flex_grow(column, 1);
    lv_obj_set_style_bg_opa(column, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(column, 0, 0);
    lv_obj_set_style_pad_all(column, 0, 0);
    lv_obj_set_style_pad_row(column, kGap, 0);
    lv_obj_set_flex_flow(column, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_scrollbar_mode(column, LV_SCROLLBAR_MODE_OFF);
    lv_obj_clear_flag(column, LV_OBJ_FLAG_SCROLLABLE);

    // Einstein va aca. En esta version la tarjeta muestra el estado en texto;
    // el sprite se suma cuando los frames esten empaquetados en assets.bin.
    pet_tile_ = MakeTile(column, lv_color_hex(kColorTurquoise), nullptr);
    lv_obj_set_flex_grow(pet_tile_, 1);
    // Alineado al tope y no centrado: centrado, cada vez que cambia el texto de
    // abajo el sprite se recorre para arriba o para abajo. Con START queda
    // clavado y solo se mueve el texto.
    lv_obj_set_flex_align(pet_tile_, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER,
                          LV_FLEX_ALIGN_CENTER);

    // status_label_ y notification_label_ son de la clase base: LvglDisplay los
    // muestra y esconde entre si, y dereferencia UNO SIN CHEQUEAR NULL cuando
    // escribe en el otro (lvgl_display.cc:159 y :185). Si SetupUI no los crea,
    // la primera notificacion de wifi tira un LoadProhibited y la placa entra
    // en boot loop. Aca viven en la tarjeta de la mascota.
    // El sprite va arriba del texto: la cara primero, el estado abajo.
    pet_anim_ = lv_animimg_create(pet_tile_);
    lv_obj_set_size(pet_anim_, kPetFrameWidth, kPetFrameHeight);

    pet_state_label_ = lv_label_create(pet_tile_);
    status_label_ = pet_state_label_;
    lv_label_set_text(pet_state_label_, "En reposo");
    lv_obj_set_width(pet_state_label_, LV_PCT(100));
    lv_label_set_long_mode(pet_state_label_, LV_LABEL_LONG_DOT);
    lv_obj_set_style_text_align(pet_state_label_, LV_TEXT_ALIGN_CENTER, 0);
    StyleTileText(pet_state_label_, kColorTurquoise);

    notification_label_ = lv_label_create(pet_tile_);
    lv_label_set_text(notification_label_, "");
    lv_obj_set_width(notification_label_, LV_PCT(100));
    lv_label_set_long_mode(notification_label_, LV_LABEL_LONG_DOT);
    lv_obj_set_style_text_align(notification_label_, LV_TEXT_ALIGN_CENTER, 0);
    StyleTileText(notification_label_, kColorInk);
    lv_obj_add_flag(notification_label_, LV_OBJ_FLAG_HIDDEN);

    pet_say_label_ = lv_label_create(pet_tile_);
    lv_label_set_text(pet_say_label_, "");
    lv_obj_set_width(pet_say_label_, LV_PCT(100));
    lv_label_set_long_mode(pet_say_label_, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_align(pet_say_label_, LV_TEXT_ALIGN_CENTER, 0);
    StyleTileText(pet_say_label_, kColorInk);

    lv_obj_t* travel = MakeTile(column, lv_color_hex(kColorGreen), nullptr);
    travel_head_label_ = lv_label_create(travel);
    lv_label_set_text(travel_head_label_, "");
    StyleTileText(travel_head_label_, kColorDim);
    travel_value_label_ = lv_label_create(travel);
    lv_label_set_text(travel_value_label_, "");
    StyleTileText(travel_value_label_, kColorInk);
    lv_obj_add_flag(travel, LV_OBJ_FLAG_HIDDEN);
}

void JarvisDashboardDisplay::RefreshClockLabel() {
    if (clock_label_ == nullptr) {
        return;
    }
    time_t now = time(nullptr);
    struct tm local_time;
    localtime_r(&now, &local_time);

    char clock_text[8];
    snprintf(clock_text, sizeof(clock_text), "%02d:%02d", local_time.tm_hour,
             local_time.tm_min);
    lv_label_set_text(clock_label_, clock_text);

    if (date_label_ != nullptr) {
        char date_text[24];
        snprintf(date_text, sizeof(date_text), "%s %d %s",
                 kWeekdayAbbreviationList[local_time.tm_wday % 7], local_time.tm_mday,
                 kMonthAbbreviationList[local_time.tm_mon % 12]);
        lv_label_set_text(date_label_, date_text);
    }
}

// Carga los frames de la particion de assets. Van ahi y no embebidos en el
// binario porque son 1,6 MB y en la app quedan 0,75 libres.
//
// GetAssetData devuelve un puntero MAPEADO EN MEMORIA a flash: no se copia nada
// a RAM. LvglCBinImage arma el lv_img_dsc_t leyendo la cabecera del .bin.
void JarvisDashboardDisplay::LoadPetFrames() {
    struct ModeSpec {
        PetAnimation* animation;
        const char* prefix;
        int frame_count;
        uint32_t duration_ms;
    };
    const ModeSpec spec_list[] = {
        {&pet_idle_, "ein_idle_", 6, kPetIdleDurationMs},
        {&pet_listening_, "ein_wait_", 6, kPetListeningDurationMs},
        {&pet_thinking_, "ein_think_", 6, kPetThinkingDurationMs},
        {&pet_talking_, "ein_talk_", 4, kPetTalkingDurationMs},
        {&pet_jump_, "ein_jump_", 5, kPetJumpDurationMs},
        {&pet_fail_, "ein_fail_", 8, kPetFailDurationMs},
        {&pet_run_, "ein_run_", 6, kPetRunDurationMs},
        {&pet_run_right_, "ein_runr_", 8, kPetRunRightDurationMs},
    };

    auto& assets = Assets::GetInstance();
    for (const auto& spec : spec_list) {
        spec.animation->duration_ms = spec.duration_ms;
        // Reservar ANTES de llenar: si el vector se reubicara, los punteros que
        // se guardan despues en source_list quedarian colgando.
        spec.animation->descriptor_list.reserve(spec.frame_count);

        for (int index = 0; index < spec.frame_count; index++) {
            char asset_name[40];
            snprintf(asset_name, sizeof(asset_name), "%s%d.bin", spec.prefix, index);
            void* data = nullptr;
            size_t size = 0;
            if (!assets.GetAssetData(asset_name, data, size)) {
                ESP_LOGW(TAG, "falta el frame %s", asset_name);
                continue;
            }
            if (size <= kLvglBinHeaderBytes) {
                ESP_LOGW(TAG, "frame corto %s (%u bytes)", asset_name, (unsigned)size);
                continue;
            }
            lv_img_dsc_t descriptor = {};
            descriptor.header.magic = LV_IMAGE_HEADER_MAGIC;
            descriptor.header.cf = LV_COLOR_FORMAT_RGB565A8;
            descriptor.header.w = kPetFrameWidth;
            descriptor.header.h = kPetFrameHeight;
            // El plano de color es RGB565 (2 bytes); el alfa va aparte, despues.
            descriptor.header.stride = kPetFrameWidth * 2;
            descriptor.data = static_cast<const uint8_t*>(data) + kLvglBinHeaderBytes;
            descriptor.data_size = size - kLvglBinHeaderBytes;
            spec.animation->descriptor_list.push_back(descriptor);
        }

        // source_list se arma recien cuando descriptor_list ya no crece mas.
        for (const auto& descriptor : spec.animation->descriptor_list) {
            spec.animation->source_list.push_back(&descriptor);
        }
        ESP_LOGI(TAG, "%s cargo %d/%d frames", spec.prefix,
                 (int)spec.animation->source_list.size(), spec.frame_count);
    }
}

void JarvisDashboardDisplay::PlayPetMode(PetMode mode) {
    if (pet_anim_ == nullptr) {
        return;
    }
    // Cualquier cambio de estado interrumpe un paseo: Einstein vuelve al centro.
    lv_anim_delete(pet_anim_, SetPetTranslateX);
    lv_obj_set_style_translate_x(pet_anim_, 0, 0);

    // El animo es de UNA respuesta: llega con el ui_state de "hablando" y se
    // olvida en cuanto pasa a otro estado (en modo conversacion no vuelve a
    // reposo entre turnos, va directo a escuchar).
    if (mode != PetMode::kTalking) {
        pet_mood_ = PetMood::kNone;
    }
    if (mode == PetMode::kIdle) {
        pet_mode_ = mode;
        StartIdleRest();
        return;
    }
    PetAnimation* animation = &pet_idle_;
    switch (mode) {
        case PetMode::kListening: animation = &pet_listening_; break;
        case PetMode::kThinking:  animation = &pet_thinking_;  break;
        case PetMode::kTalking:   animation = AnimationForTalking(); break;
        case PetMode::kIdle:      break;
    }
    // Un modo sin frames (asset faltante) no debe dejar la tarjeta en blanco:
    // se queda con el que estaba sonando.
    if (animation->source_list.empty()) {
        return;
    }
    pet_mode_ = mode;
    idle_act_ = IdleAct::kRest;
    PlayPetAnimation(animation, LV_ANIM_REPEAT_INFINITE);
}

void JarvisDashboardDisplay::PlayPetAnimation(PetAnimation* animation, uint32_t repeat_count) {
    if (pet_anim_ == nullptr || animation == nullptr || animation->source_list.empty()) {
        return;
    }
    lv_animimg_set_src(pet_anim_, (const void**)animation->source_list.data(),
                       animation->source_list.size());
    lv_animimg_set_duration(pet_anim_, animation->duration_ms);
    lv_animimg_set_repeat_count(pet_anim_, repeat_count);
    lv_animimg_start(pet_anim_);
}

// Mientras habla, la cara sigue el animo de la respuesta; sin animo (o sin los
// frames de ese animo) es el saludo de siempre.
JarvisDashboardDisplay::PetAnimation* JarvisDashboardDisplay::AnimationForTalking() {
    PetAnimation* animation = &pet_talking_;
    switch (pet_mood_) {
        case PetMood::kCelebrate: animation = &pet_jump_; break;
        case PetMood::kSad:       animation = &pet_fail_; break;
        case PetMood::kHurry:     animation = &pet_run_; break;
        case PetMood::kPensive:   animation = &pet_thinking_; break;
        case PetMood::kNone:      break;
    }
    return animation->source_list.empty() ? &pet_talking_ : animation;
}

void JarvisDashboardDisplay::SetMood(const char* mood) {
    DisplayLockGuard lock(this);
    PetMood parsed = PetMood::kNone;
    if (mood != nullptr) {
        if (strcmp(mood, "festejo") == 0) {
            parsed = PetMood::kCelebrate;
        } else if (strcmp(mood, "triste") == 0) {
            parsed = PetMood::kSad;
        } else if (strcmp(mood, "apurado") == 0) {
            parsed = PetMood::kHurry;
        } else if (strcmp(mood, "pensativo") == 0) {
            parsed = PetMood::kPensive;
        }
    }
    if (parsed == pet_mood_) {
        return;
    }
    pet_mood_ = parsed;
    ESP_LOGI(TAG, "Einstein: animo %s", mood == nullptr ? "neutro" : mood);
    // Si ya esta hablando (el animo llego despues del primer segmento), cambia
    // la cara en el momento.
    if (pet_mode_ == PetMode::kTalking) {
        PlayPetAnimation(AnimationForTalking(), LV_ANIM_REPEAT_INFINITE);
    }
}

uint32_t JarvisDashboardDisplay::RandomBetween(uint32_t low, uint32_t high) {
    if (high <= low) {
        return low;
    }
    return low + esp_random() % (high - low);
}

void JarvisDashboardDisplay::ShowPetStill(const PetAnimation& animation, int frame_index) {
    if (pet_anim_ == nullptr || frame_index < 0 ||
        frame_index >= (int)animation.source_list.size()) {
        return;
    }
    lv_animimg_delete(pet_anim_);
    lv_image_set_src(pet_anim_, animation.source_list[frame_index]);
}

void JarvisDashboardDisplay::StartIdleRest() {
    uint32_t now = lv_tick_get();
    idle_act_ = IdleAct::kRest;
    ShowPetStill(pet_idle_, kPetRestFrame);
    next_blink_at_ms_ = now + RandomBetween(kBlinkMinGapMs, kBlinkMaxGapMs);
    // Gesto y paseo se reprograman solo si nunca se programaron o ya vencieron
    // (TickIdleLife los corre apenas tocan). Reprogramarlos en cada reposo los
    // empujaba para adelante con cada parpadeo y no llegaban nunca.
    if (next_gesture_at_ms_ == 0 || (int32_t)(next_gesture_at_ms_ - now) < 0) {
        next_gesture_at_ms_ = now + RandomBetween(kGestureMinGapMs, kGestureMaxGapMs);
    }
    if (next_walk_at_ms_ == 0 || (int32_t)(next_walk_at_ms_ - now) < 0) {
        next_walk_at_ms_ = now + RandomBetween(kWalkMinGapMs, kWalkMaxGapMs);
    }
}

// Sale corriendo por la derecha y vuelve a entrar por la izquierda: la tarjeta
// recorta lo que queda fuera, asi que parece que da la vuelta.
void JarvisDashboardDisplay::StartWalk(bool walking_out) {
    if (pet_run_right_.source_list.empty() || pet_tile_ == nullptr) {
        next_walk_at_ms_ = lv_tick_get() + RandomBetween(kWalkMinGapMs, kWalkMaxGapMs);
        return;
    }
    int32_t distance = lv_obj_get_width(pet_tile_) / 2 + kPetFrameWidth / 2 + 10;
    if (walking_out) {
        ESP_LOGI(TAG, "Einstein: sale a pasear");
        PlayPetAnimation(&pet_run_right_, LV_ANIM_REPEAT_INFINITE);
    }
    lv_anim_delete(pet_anim_, SetPetTranslateX);
    lv_anim_t animation;
    lv_anim_init(&animation);
    lv_anim_set_var(&animation, pet_anim_);
    lv_anim_set_exec_cb(&animation, SetPetTranslateX);
    lv_anim_set_values(&animation, walking_out ? 0 : -distance, walking_out ? distance : 0);
    lv_anim_set_duration(&animation, kWalkLegMs);
    lv_anim_start(&animation);
    idle_act_ = walking_out ? IdleAct::kWalkOut : IdleAct::kWalkIn;
    idle_act_ends_at_ms_ = lv_tick_get() + kWalkLegMs + 50;
}

void JarvisDashboardDisplay::OnIdleLifeTimer(lv_timer_t* timer) {
    auto* self = static_cast<JarvisDashboardDisplay*>(lv_timer_get_user_data(timer));
    self->TickIdleLife();
}

void JarvisDashboardDisplay::TickIdleLife() {
    if (asleep_ || pet_mode_ != PetMode::kIdle || pet_anim_ == nullptr) {
        return;
    }
    uint32_t now = lv_tick_get();
    auto due = [now](uint32_t at) { return (int32_t)(now - at) >= 0; };

    switch (idle_act_) {
        case IdleAct::kRest:
            if (due(next_walk_at_ms_)) {
                next_walk_at_ms_ = now + RandomBetween(kWalkMinGapMs, kWalkMaxGapMs);
                StartWalk(true);
            } else if (due(next_gesture_at_ms_)) {
                next_gesture_at_ms_ = now + RandomBetween(kGestureMinGapMs, kGestureMaxGapMs);
                // Un gesto corto y al azar: se balancea (el loop de idle, que
                // es justo el que no sirve de reposo), se pone pensativo,
                // saluda, o muy de vez en cuando pega un salto.
                PetAnimation* gesture = &pet_idle_;
                uint32_t repeats = 2;
                uint32_t pick = esp_random() % 10;
                if (pick < 4) {
                    gesture = &pet_idle_;
                } else if (pick < 7) {
                    gesture = &pet_thinking_;
                    repeats = 2;
                } else if (pick < 9) {
                    gesture = &pet_talking_;
                    repeats = 2;
                } else {
                    gesture = &pet_jump_;
                    repeats = 1;
                }
                if (gesture->source_list.empty()) {
                    gesture = &pet_idle_;
                }
                ESP_LOGI(TAG, "Einstein: gesto %d", (int)pick);
                PlayPetAnimation(gesture, repeats);
                idle_act_ = IdleAct::kGesture;
                idle_act_ends_at_ms_ = now + gesture->duration_ms * repeats;
            } else if (due(next_blink_at_ms_)) {
                // Uno de cada cuatro es doble: cerrado, abierto, cerrado.
                blinks_left_ = (esp_random() % 4 == 0) ? 3 : 1;
                ShowPetStill(pet_idle_, kPetBlinkFrame);
                idle_act_ = IdleAct::kBlink;
                idle_act_ends_at_ms_ = now + kBlinkClosedMs;
            }
            break;
        case IdleAct::kBlink:
            if (due(idle_act_ends_at_ms_)) {
                blinks_left_--;
                if (blinks_left_ <= 0) {
                    StartIdleRest();
                } else {
                    bool eyes_open = (blinks_left_ % 2) == 0;
                    ShowPetStill(pet_idle_, eyes_open ? kPetRestFrame : kPetBlinkFrame);
                    idle_act_ends_at_ms_ = now + (eyes_open ? kBlinkOpenGapMs : kBlinkClosedMs);
                }
            }
            break;
        case IdleAct::kGesture:
            if (due(idle_act_ends_at_ms_)) {
                StartIdleRest();
            }
            break;
        case IdleAct::kWalkOut:
            if (due(idle_act_ends_at_ms_)) {
                StartWalk(false);
            }
            break;
        case IdleAct::kWalkIn:
            if (due(idle_act_ends_at_ms_)) {
                lv_obj_set_style_translate_x(pet_anim_, 0, 0);
                StartIdleRest();
            }
            break;
    }
}

void JarvisDashboardDisplay::SetPowerSaveMode(bool on) {
    RgbLcdDisplay::SetPowerSaveMode(on);
    DisplayLockGuard lock(this);
    asleep_ = on;
    if (pet_anim_ == nullptr) {
        return;
    }
    if (on) {
        // Con la pantalla apagada no se anima nada: dormido, con los ojos
        // cerrados, y el timer en pausa para no gastar CPU.
        lv_anim_delete(pet_anim_, SetPetTranslateX);
        lv_obj_set_style_translate_x(pet_anim_, 0, 0);
        ShowPetStill(pet_idle_, kPetBlinkFrame);
        if (idle_life_timer_ != nullptr) {
            lv_timer_pause(idle_life_timer_);
        }
    } else {
        if (idle_life_timer_ != nullptr) {
            lv_timer_resume(idle_life_timer_);
        }
        if (pet_mode_ == PetMode::kIdle) {
            StartIdleRest();
        }
    }
}

void JarvisDashboardDisplay::SetupUI() {
    if (setup_ui_called_) {
        ESP_LOGW(TAG, "SetupUI() llamado dos veces, se ignora");
        return;
    }
    Display::SetupUI();
    DisplayLockGuard lock(this);

    auto screen = lv_screen_active();
    auto lvgl_theme = static_cast<LvglTheme*>(current_theme_);
    {
        auto screen_font = SafeFont(lvgl_theme->text_font());
        if (screen_font != nullptr) {
            lv_obj_set_style_text_font(screen, screen_font, 0);
        }
    }
    lv_obj_set_style_text_color(screen, lv_color_hex(kColorInk), 0);
    lv_obj_set_style_bg_color(screen, lv_color_hex(kColorScreen), 0);

    container_ = lv_obj_create(screen);
    lv_obj_set_size(container_, LV_HOR_RES, LV_VER_RES);
    lv_obj_set_style_bg_color(container_, lv_color_hex(kColorScreen), 0);
    lv_obj_set_style_border_width(container_, 0, 0);
    lv_obj_set_style_radius(container_, 0, 0);
    lv_obj_set_style_pad_all(container_, kOuterPad, 0);
    lv_obj_set_style_pad_row(container_, kGap, 0);
    lv_obj_set_flex_flow(container_, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_scrollbar_mode(container_, LV_SCROLLBAR_MODE_OFF);
    lv_obj_clear_flag(container_, LV_OBJ_FLAG_SCROLLABLE);

    BuildStatusBar(container_);

    lv_obj_t* grid = lv_obj_create(container_);
    lv_obj_set_width(grid, LV_PCT(100));
    lv_obj_set_flex_grow(grid, 1);
    lv_obj_set_style_bg_opa(grid, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(grid, 0, 0);
    lv_obj_set_style_pad_all(grid, 0, 0);
    lv_obj_set_style_pad_column(grid, kGap, 0);
    lv_obj_set_flex_flow(grid, LV_FLEX_FLOW_ROW);
    lv_obj_set_scrollbar_mode(grid, LV_SCROLLBAR_MODE_OFF);
    lv_obj_clear_flag(grid, LV_OBJ_FLAG_SCROLLABLE);

    BuildAgendaColumn(grid);
    BuildPendingColumn(grid);
    BuildPetColumn(grid);

    // Aviso de bateria baja: lo muestra y esconde UpdateStatusBar por su cuenta.
    low_battery_popup_ = lv_obj_create(screen);
    lv_obj_set_scrollbar_mode(low_battery_popup_, LV_SCROLLBAR_MODE_OFF);
    lv_obj_set_size(low_battery_popup_, LV_HOR_RES * 0.6, 64);
    lv_obj_align(low_battery_popup_, LV_ALIGN_BOTTOM_MID, 0, -12);
    lv_obj_set_style_bg_color(low_battery_popup_, lvgl_theme->low_battery_color(), 0);
    lv_obj_set_style_radius(low_battery_popup_, 9, 0);
    low_battery_label_ = lv_label_create(low_battery_popup_);
    lv_label_set_text(low_battery_label_, Lang::Strings::BATTERY_NEED_CHARGE);
    lv_obj_set_style_text_color(low_battery_label_, lv_color_white(), 0);
    lv_obj_center(low_battery_label_);
    lv_obj_add_flag(low_battery_popup_, LV_OBJ_FLAG_HIDDEN);

    BuildReminderOverlay(screen);

    // El reloj corre con el RTC de la placa. Diez segundos alcanzan para que la
    // hora nunca se vea vieja y no despierta al procesador cada segundo.
    esp_timer_create_args_t clock_timer_args = {};
    clock_timer_args.callback = [](void* argument) {
        auto* self = static_cast<JarvisDashboardDisplay*>(argument);
        DisplayLockGuard timer_lock(self);
        self->RefreshClockLabel();
    };
    clock_timer_args.arg = this;
    clock_timer_args.name = "jarvis_clock";
    if (esp_timer_create(&clock_timer_args, &clock_timer_) == ESP_OK) {
        esp_timer_start_periodic(clock_timer_, kClockTickPeriodMicroseconds);
    }

    LoadPetFrames();
    PlayPetMode(PetMode::kIdle);
    idle_life_timer_ = lv_timer_create(OnIdleLifeTimer, kIdleLifeTickMs, this);

    // OJO: sin esto la pantalla queda NEGRA.
    //
    // El puerto de LVGL para este panel RGB corre con direct_mode + full_refresh
    // (ver RgbLcdDisplay). En ese modo se dibuja solo lo invalidado, y al salir
    // de SetupUI el layout del flex todavia no se calculo: los objetos miden
    // cero, no invalidan area, y no se dibuja nada nunca. Forzar el layout les
    // da tamano real, y el invalidate manda a repintar la pantalla entera una
    // primera vez.
    //
    // Verificado por A/B: los builds con esta llamada se ven, los que no la
    // tienen arrancan en negro con la placa perfectamente sana.
    lv_obj_update_layout(container_);
    lv_obj_invalidate(lv_screen_active());

    ESP_LOGI(TAG, "tablero armado: %dx%d (container %dx%d)", LV_HOR_RES, LV_VER_RES,
             (int)lv_obj_get_width(container_), (int)lv_obj_get_height(container_));
}

// LcdDisplay::SetTheme repinta la UI de chat entera y toca `emoji_label_`,
// `content_` y compania sin chequear null: como el tablero no crea nada de eso,
// heredarlo era un LoadProhibited garantizado apenas Assets::Apply cambia la
// fuente al arrancar (lcd_display.cc:1235).
//
// Ademas el tablero tiene paleta propia y fija: del tema solo le interesan las
// fuentes, no los colores.
void JarvisDashboardDisplay::SetTheme(Theme* theme) {
    DisplayLockGuard lock(this);
    auto lvgl_theme = static_cast<LvglTheme*>(theme);
    auto text_font = SafeFont(lvgl_theme->text_font());
    auto icon_font = SafeFont(lvgl_theme->icon_font());

    lv_obj_set_style_text_font(lv_screen_active(), text_font, 0);

    lv_obj_t* const icon_label_list[] = {network_label_, battery_label_, mute_label_};
    for (lv_obj_t* label : icon_label_list) {
        if (label != nullptr && icon_font != nullptr) {
            lv_obj_set_style_text_font(label, icon_font, 0);
        }
    }

    // El resto de los labels no fija fuente: hereda la de la pantalla, que ya
    // se actualizo arriba. Ver el comentario de StyleTileText.

    // Solo el bookkeeping de la base (guarda el tema y lo persiste), sin el
    // repintado de LcdDisplay.
    Display::SetTheme(theme);
}

void JarvisDashboardDisplay::SetDashboardData(const DashboardData& data) {
    DisplayLockGuard lock(this);
    auto lvgl_theme = static_cast<LvglTheme*>(current_theme_);
    auto text_font = SafeFont(lvgl_theme->text_font());

    if (weather_temp_label_ != nullptr && data.weather_present) {
        if (data.has_weather) {
            char temperature_text[8];
            snprintf(temperature_text, sizeof(temperature_text), "%d", data.temperature_c);
            lv_label_set_text(weather_temp_label_, temperature_text);
            lv_label_set_text(weather_cond_label_, data.condition_label.c_str());
            lv_label_set_text(weather_place_label_, data.place_label.c_str());
        } else {
            lv_label_set_text(weather_temp_label_, "--");
            lv_label_set_text(weather_cond_label_, "");
            lv_label_set_text(weather_place_label_, "");
        }
    }

    for (int slot = 0; data.agenda_present && slot < kAgendaSlotCount; slot++) {
        const bool used = slot < (int)data.agenda_list.size();
        if (used) {
            lv_label_set_text(agenda_title_list_[slot], data.agenda_list[slot].title.c_str());
            lv_label_set_text(agenda_when_list_[slot], data.agenda_list[slot].when_label.c_str());
        }
        // Se muestran u ocultan, nunca se crean ni se destruyen.
        for (lv_obj_t* label : {agenda_title_list_[slot], agenda_when_list_[slot]}) {
            if (used) {
                lv_obj_clear_flag(label, LV_OBJ_FLAG_HIDDEN);
            } else {
                lv_obj_add_flag(label, LV_OBJ_FLAG_HIDDEN);
            }
        }
    }

    for (int slot = 0; data.pending_present && slot < kPendingSlotCount; slot++) {
        const bool used = slot < (int)data.pending_item_list.size();
        if (used) {
            // El punto va en el texto: un objeto menos por fila, y son cuatro.
            const std::string bulleted = "- " + data.pending_item_list[slot];
            lv_label_set_text(pending_row_list_[slot], bulleted.c_str());
            lv_obj_clear_flag(pending_row_list_[slot], LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(pending_row_list_[slot], LV_OBJ_FLAG_HIDDEN);
        }
    }
    if (pending_count_label_ != nullptr && data.pending_present) {
        char count_text[8];
        snprintf(count_text, sizeof(count_text), "%d", data.pending_count);
        lv_label_set_text(pending_count_label_, data.has_pending ? count_text : "");
    }

    if (travel_value_label_ != nullptr && data.travel_present) {
        lv_obj_t* travel_tile = lv_obj_get_parent(travel_value_label_);
        if (data.has_travel) {
            char minutes_text[16];
            snprintf(minutes_text, sizeof(minutes_text), "%d min", data.travel_minutes);
            lv_label_set_text(travel_head_label_, data.travel_label.c_str());
            lv_label_set_text(travel_value_label_, minutes_text);
            lv_obj_clear_flag(travel_tile, LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(travel_tile, LV_OBJ_FLAG_HIDDEN);
        }
    }
}

// El recordatorio se dibuja una sola vez, escondido, y despues solo se le
// cambia el texto. Mismo motivo que las filas del tablero: recrear objetos en
// cada aviso hace recalcular el arbol entero y la pantalla parpadea.
void JarvisDashboardDisplay::BuildReminderOverlay(lv_obj_t* parent) {
    reminder_overlay_ = lv_obj_create(parent);
    lv_obj_set_size(reminder_overlay_, LV_HOR_RES, LV_VER_RES);
    lv_obj_align(reminder_overlay_, LV_ALIGN_TOP_LEFT, 0, 0);
    lv_obj_set_style_bg_color(reminder_overlay_, lv_color_hex(kColorScreen), 0);
    lv_obj_set_style_bg_opa(reminder_overlay_, LV_OPA_COVER, 0);
    // El borde grueso es lo que lo separa de "otra pantalla del tablero": el
    // naranja ya es el color de agenda y recordatorios en el resto de la UI.
    lv_obj_set_style_border_color(reminder_overlay_, lv_color_hex(kColorTangerine), 0);
    lv_obj_set_style_border_width(reminder_overlay_, 6, 0);
    lv_obj_set_style_radius(reminder_overlay_, 0, 0);
    lv_obj_set_style_pad_all(reminder_overlay_, 40, 0);
    lv_obj_set_style_pad_row(reminder_overlay_, 22, 0);
    lv_obj_set_flex_flow(reminder_overlay_, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(reminder_overlay_, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER,
                          LV_FLEX_ALIGN_CENTER);
    lv_obj_set_scrollbar_mode(reminder_overlay_, LV_SCROLLBAR_MODE_OFF);
    lv_obj_clear_flag(reminder_overlay_, LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t* heading = lv_label_create(reminder_overlay_);
    lv_label_set_text(heading, "RECORDATORIO");
    lv_obj_set_style_text_letter_space(heading, 3, 0);
    StyleTileText(heading, kColorTangerine);

    reminder_message_label_ = lv_label_create(reminder_overlay_);
    lv_label_set_text(reminder_message_label_, "");
    lv_obj_set_width(reminder_message_label_, LV_PCT(100));
    lv_label_set_long_mode(reminder_message_label_, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_align(reminder_message_label_, LV_TEXT_ALIGN_CENTER, 0);
    // Sin fuente propia a proposito: fijarla en el estilo local deja el label
    // apuntando a memoria liberada cuando Assets::Apply cambia la del tema.
    // La jerarquia la da el color y el espacio, no el tamano de letra.
    StyleTileText(reminder_message_label_, kColorInk);

    lv_obj_t* hint = lv_label_create(reminder_overlay_);
    lv_label_set_text(hint, "toca la pantalla para descartar");
    StyleTileText(hint, kColorDim);

    lv_obj_add_flag(reminder_overlay_, LV_OBJ_FLAG_HIDDEN);
}

void JarvisDashboardDisplay::ShowReminder(const char* message) {
    DisplayLockGuard lock(this);
    if (reminder_overlay_ == nullptr || reminder_message_label_ == nullptr) {
        return;
    }
    lv_label_set_text(reminder_message_label_, message == nullptr ? "" : message);
    lv_obj_remove_flag(reminder_overlay_, LV_OBJ_FLAG_HIDDEN);
    // El aviso de bateria tambien cuelga de `screen` y se creo despues; sin
    // esto podria quedar tapando el recordatorio.
    lv_obj_move_foreground(reminder_overlay_);
    // direct_mode + full_refresh: mostrar un objeto no alcanza, hay que pedir
    // el repintado de la pantalla entera o queda dibujado lo de antes. Es el
    // mismo motivo por el que SetupUI termina con un invalidate.
    lv_obj_invalidate(lv_screen_active());
}

void JarvisDashboardDisplay::DismissReminder() {
    DisplayLockGuard lock(this);
    if (reminder_overlay_ == nullptr) {
        return;
    }
    lv_obj_add_flag(reminder_overlay_, LV_OBJ_FLAG_HIDDEN);
    lv_obj_invalidate(lv_screen_active());
}

// Toma el lock como todo lo demas que toca LVGL: se llama desde la main task
// (SendGesture) mientras la tarea de LVGL puede estar dibujando. El mutex del
// puerto es recursivo, asi que anidarlo con el de DismissReminder es seguro.
bool JarvisDashboardDisplay::IsReminderVisible() {
    DisplayLockGuard lock(this);
    return reminder_overlay_ != nullptr &&
           !lv_obj_has_flag(reminder_overlay_, LV_OBJ_FLAG_HIDDEN);
}

void JarvisDashboardDisplay::SetChatMessage(const char* role, const char* content) {
    DisplayLockGuard lock(this);
    if (pet_say_label_ == nullptr) {
        return;
    }
    lv_label_set_text(pet_say_label_, content == nullptr ? "" : content);
}

// Las emociones que manda el servidor se agrupan en los cuatro modos que tiene
// el sprite. Cualquiera que no encaje cae en reposo, que es el unico que siempre
// tiene frames.
void JarvisDashboardDisplay::SetEmotion(const char* emotion) {
    if (emotion == nullptr) {
        return;
    }
    DisplayLockGuard lock(this);
    PetMode mode = PetMode::kIdle;
    if (strcmp(emotion, "listening") == 0 || strcmp(emotion, "curious") == 0) {
        mode = PetMode::kListening;
    } else if (strcmp(emotion, "thinking") == 0 || strcmp(emotion, "focused") == 0 ||
               strcmp(emotion, "questioning") == 0) {
        mode = PetMode::kThinking;
    } else if (strcmp(emotion, "speaking") == 0 || strcmp(emotion, "talking") == 0 ||
               strcmp(emotion, "happy") == 0 || strcmp(emotion, "laughing") == 0) {
        mode = PetMode::kTalking;
    }
    // Empezar a hablarle a Jarvis tambien descarta el recordatorio.
    //
    // Es la red de seguridad del overlay: sin esto la UNICA salida es el
    // touch, y si el panel falla la pantalla queda tomada para siempre sin
    // forma de recuperarla. Ademas es lo que corresponde: si estas hablandole,
    // ya lo viste.
    //
    // El anuncio del propio recordatorio no dispara esto: announcePcm manda
    // tts_start/tts_end/turn_end pero ningun mensaje de emocion, asi que el
    // aviso no se borra a si mismo mientras lo esta leyendo.
    if (mode == PetMode::kListening) {
        DismissReminder();
    }

    if (mode != pet_mode_) {
        PlayPetMode(mode);
    }
}

void JarvisDashboardDisplay::SetAccentColor(const char* color) {
    if (color == nullptr || color[0] != '#') {
        return;
    }
    DisplayLockGuard lock(this);
    accent_color_ = LvglTheme::ParseColor(color);
    if (pet_state_label_ != nullptr) {
        lv_obj_set_style_text_color(pet_state_label_, accent_color_, 0);
    }
}
