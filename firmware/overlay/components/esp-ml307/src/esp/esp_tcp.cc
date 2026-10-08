#include "esp_tcp.h"

#include <esp_log.h>
#include <unistd.h>
#include <cstring>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <netdb.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/tcp.h>
#include <sys/select.h>

static const char *TAG = "EspTcp";

// Jarvis (2026-09-30): el original bloqueaba connect() y send() sin límite. Con
// el repetidor WiFi (picos de ~1 s, 2,5 % de pérdida) un send() podía quedarse
// minutos esperando ventana TCP, y como se llama desde el loop principal de la
// aplicación, la placa quedaba "muda": ni reconexión ni palabra de activación.
// Ahora todo tiene tiempo máximo y un enlace muerto se detecta por keepalive.
static constexpr int kConnectTimeoutMs = 5000;
static constexpr int kSendTimeoutMs = 3000;
static constexpr int kKeepAliveIdleSeconds = 10;
static constexpr int kKeepAliveIntervalSeconds = 5;
static constexpr int kKeepAliveCount = 3;

// connect() con tiempo máximo: no bloqueante + select, y de vuelta a bloqueante.
static int ConnectWithTimeout(int fd, const struct sockaddr* address, socklen_t length, int timeout_ms) {
    int flags = fcntl(fd, F_GETFL, 0);
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);
    int ret = connect(fd, address, length);
    if (ret < 0 && errno != EINPROGRESS) {
        fcntl(fd, F_SETFL, flags);
        return -1;
    }
    if (ret < 0) {
        fd_set write_set;
        FD_ZERO(&write_set);
        FD_SET(fd, &write_set);
        struct timeval timeout = {.tv_sec = timeout_ms / 1000, .tv_usec = (timeout_ms % 1000) * 1000};
        ret = select(fd + 1, nullptr, &write_set, nullptr, &timeout);
        if (ret <= 0) {
            errno = ret == 0 ? ETIMEDOUT : errno;
            fcntl(fd, F_SETFL, flags);
            return -1;
        }
        int socket_error = 0;
        socklen_t error_length = sizeof(socket_error);
        getsockopt(fd, SOL_SOCKET, SO_ERROR, &socket_error, &error_length);
        if (socket_error != 0) {
            errno = socket_error;
            fcntl(fd, F_SETFL, flags);
            return -1;
        }
    }
    fcntl(fd, F_SETFL, flags);
    return 0;
}

EspTcp::EspTcp() {
    event_group_ = xEventGroupCreate();
}

EspTcp::~EspTcp() {
    Disconnect();

    if (event_group_ != nullptr) {
        vEventGroupDelete(event_group_);
        event_group_ = nullptr;
    }
}

bool EspTcp::Connect(const std::string& host, int port) {
    // 确保先断开已有连接
    if (connected_) {
        Disconnect();
    }

    struct sockaddr_in server_addr;
    bzero(&server_addr, sizeof(server_addr));
    server_addr.sin_family = AF_INET;
    server_addr.sin_port = htons(port);
    // host is domain
    struct hostent *server = gethostbyname(host.c_str());
    if (server == NULL) {
        last_error_ = h_errno;
        ESP_LOGE(TAG, "Failed to get host by name");
        return false;
    }
    memcpy(&server_addr.sin_addr, server->h_addr, server->h_length);
    ESP_LOGI(TAG, "Resolved %s -> %s", host.c_str(), inet_ntoa(*(struct in_addr *)server->h_addr));

    tcp_fd_ = socket(AF_INET, SOCK_STREAM, 0);
    if (tcp_fd_ < 0) {
        last_error_ = errno;
        ESP_LOGE(TAG, "Failed to create socket");
        return false;
    }

    int ret = ConnectWithTimeout(tcp_fd_, (struct sockaddr*)&server_addr, sizeof(server_addr),
                                 kConnectTimeoutMs);
    if (ret < 0) {
        last_error_ = errno;
        ESP_LOGE(TAG, "Failed to connect to %s:%d, code=0x%x", host.c_str(), port, last_error_);
        close(tcp_fd_);
        tcp_fd_ = -1;
        return false;
    }

    // Envíos con tiempo máximo y keepalive para notar un enlace muerto en ~25 s
    // (sin esto, solo el timeout de inactividad de 120 s del protocolo).
    struct timeval send_timeout = {.tv_sec = kSendTimeoutMs / 1000, .tv_usec = (kSendTimeoutMs % 1000) * 1000};
    setsockopt(tcp_fd_, SOL_SOCKET, SO_SNDTIMEO, &send_timeout, sizeof(send_timeout));
    int enable = 1;
    setsockopt(tcp_fd_, SOL_SOCKET, SO_KEEPALIVE, &enable, sizeof(enable));
    int keep_idle = kKeepAliveIdleSeconds;
    int keep_interval = kKeepAliveIntervalSeconds;
    int keep_count = kKeepAliveCount;
    setsockopt(tcp_fd_, IPPROTO_TCP, TCP_KEEPIDLE, &keep_idle, sizeof(keep_idle));
    setsockopt(tcp_fd_, IPPROTO_TCP, TCP_KEEPINTVL, &keep_interval, sizeof(keep_interval));
    setsockopt(tcp_fd_, IPPROTO_TCP, TCP_KEEPCNT, &keep_count, sizeof(keep_count));
    // El audio va en frames chicos y seguidos: Nagle solo agrega demora.
    setsockopt(tcp_fd_, IPPROTO_TCP, TCP_NODELAY, &enable, sizeof(enable));

    connected_ = true;

    xEventGroupClearBits(event_group_, ESP_TCP_EVENT_RECEIVE_TASK_EXIT);
    xTaskCreate([](void* arg) {
        EspTcp* tcp = (EspTcp*)arg;
        tcp->ReceiveTask();
        xEventGroupSetBits(tcp->event_group_, ESP_TCP_EVENT_RECEIVE_TASK_EXIT);
        vTaskDelete(NULL);
    }, "tcp_receive", 4096, this, 1, &receive_task_handle_);
    return true;
}

void EspTcp::Disconnect() {
    // 如果已经断开，直接返回
    if (!connected_) {
        return;
    }

    // 主动断开，需要等待接收任务退出
    DoDisconnect(true);
}

void EspTcp::DoDisconnect(bool wait_for_task) {
    connected_ = false;

    if (tcp_fd_ != -1) {
        close(tcp_fd_);
        tcp_fd_ = -1;

        // 只有主动断开时才需要等待接收任务退出
        // 被动断开时，当前就是接收任务，不需要等待
        if (wait_for_task) {
            auto bits = xEventGroupWaitBits(event_group_, ESP_TCP_EVENT_RECEIVE_TASK_EXIT, pdFALSE, pdFALSE, pdMS_TO_TICKS(10000));
            if (!(bits & ESP_TCP_EVENT_RECEIVE_TASK_EXIT)) {
                ESP_LOGE(TAG, "Failed to wait for receive task exit");
            }
        }
    }

    // 断开连接时触发断开回调
    if (disconnect_callback_) {
        disconnect_callback_();
    }
}

int EspTcp::Send(const std::string& data) {
    if (!connected_) {
        ESP_LOGE(TAG, "Not connected");
        return -1;
    }

    size_t total_sent = 0;
    size_t data_size = data.size();
    const char* data_ptr = data.data();

    while (total_sent < data_size) {
        int ret = send(tcp_fd_, data_ptr + total_sent, data_size - total_sent, 0);

        if (ret <= 0) {
            ESP_LOGE(TAG, "Send failed: ret=%d, errno=%d", ret, errno);
            if (errno == EAGAIN || errno == EWOULDBLOCK) {
                // Venció el tiempo de envío: el enlace está trabado. Se corta el
                // socket para que la tarea de recepción cierre la conexión y la
                // aplicación reconecte, en vez de reintentar cada frame 3 s.
                ESP_LOGW(TAG, "Send timed out after %d ms; dropping the connection", kSendTimeoutMs);
                shutdown(tcp_fd_, SHUT_RDWR);
            }
            return ret;
        }

        total_sent += ret;
    }

    return total_sent;
}

void EspTcp::ReceiveTask() {
    std::string data;
    while (connected_) {
        data.resize(1500);
        int ret = recv(tcp_fd_, data.data(), data.size(), 0);
        if (ret <= 0) {
            if (ret < 0) {
                ESP_LOGE(TAG, "TCP receive failed: %d", ret);
            }
            // 被动断开，不需要等待接收任务退出（当前就是接收任务）
            DoDisconnect(false);
            break;
        }

        if (stream_callback_) {
            data.resize(ret);
            stream_callback_(data);
        }
    }
}

int EspTcp::GetLastError() {
    return last_error_;
}
