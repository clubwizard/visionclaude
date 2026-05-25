import Foundation
import AVFoundation

/// Bridges the iOS app to either:
/// - Channel mode (WebSocket → Claude Code session, uses ALL your MCP tools + skills)
/// - Gateway mode (REST → standalone gateway server, uses Claude API)
///
/// Channel mode is the default and preferred mode.
class ClaudeBridge: NSObject, ObservableObject, URLSessionWebSocketDelegate {
    @Published var isConnected: Bool = false
    @Published var mode: ConnectionMode = .channel

    enum ConnectionMode: String {
        case channel  // WebSocket → Claude Code session
        case gateway  // REST → gateway server (fallback)
    }

    // Callbacks
    var onReply: ((String, String?) -> Void)?    // (text, audioURL?)
    var onStatus: ((String) -> Void)?
    var onThinking: ((String) -> Void)?
    var onDisconnect: (() -> Void)?
    /// Cowork pull-pattern: server asks for a fresh camera snapshot.
    /// The host (SessionViewModel) should capture a frame from the
    /// active source and call `fulfilSnapshot(requestId:image:source:)`.
    /// Args: (requestId, source: "iphone" or "rayban", prompt?)
    var onSnapshotRequest: ((String, String, String?) -> Void)?
    /// Cowork pull-pattern: server asks the user a clarifying question.
    /// The host should start STT, then call `fulfilVoice(requestId:text:)`
    /// with the transcribed reply. The prompt is already spoken via the
    /// reply callback that accompanies this message.
    /// Args: (requestId, prompt, timeoutMs)
    var onVoiceRequest: ((String, String, Int) -> Void)?

    private var webSocket: URLSessionWebSocketTask?
    private var urlSession: URLSession?
    private var config: ClaudeConfig
    private var conversationId: String?
    private var reconnectAttempts = 0
    private let maxReconnectAttempts = 5
    private var isManualDisconnect = false
    private var pingTimer: Timer?

    init(config: ClaudeConfig) {
        self.config = config
        super.init()
    }

    func updateConfig(_ config: ClaudeConfig) {
        self.config = config
    }

    // MARK: - Channel Mode (WebSocket)

    func connectWebSocket() {
        isManualDisconnect = false
        reconnectAttempts = 0

        let wsURL = config.wsURL
        print("[Bridge] Connecting WebSocket to \(wsURL)")

        let session = URLSession(configuration: .default, delegate: self, delegateQueue: .main)
        self.urlSession = session
        var request = URLRequest(url: wsURL)
        if !config.channelToken.isEmpty {
            request.setValue("Bearer \(config.channelToken)", forHTTPHeaderField: "Authorization")
        }
        let task = session.webSocketTask(with: request)
        self.webSocket = task
        task.resume()
        receiveMessage()
    }

    func disconnect() {
        isManualDisconnect = true
        pingTimer?.invalidate()
        pingTimer = nil
        webSocket?.cancel(with: .goingAway, reason: nil)
        webSocket = nil
        isConnected = false
        onDisconnect?()
    }

    private func receiveMessage() {
        webSocket?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    self.handleWebSocketMessage(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self.handleWebSocketMessage(text)
                    }
                @unknown default:
                    break
                }
                self.receiveMessage() // Keep listening
            case .failure(let error):
                print("[Bridge] WebSocket receive error: \(error)")
                DispatchQueue.main.async {
                    self.isConnected = false
                    self.attemptReconnect()
                }
            }
        }
    }

    private func handleWebSocketMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return }

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            switch type {
            case "status":
                let status = json["status"] as? String ?? ""
                print("[Bridge] Status: \(status)")
                if status == "connected" {
                    self.isConnected = true
                    self.reconnectAttempts = 0
                    self.startPingTimer()
                }
                self.onStatus?(status)

            case "reply":
                let replyText = json["text"] as? String ?? ""
                let audioUrl = json["audio_url"] as? String
                let fullAudioUrl: String?
                if let audioPath = audioUrl {
                    fullAudioUrl = "http://\(self.config.gatewayHost):\(self.config.gatewayPort)\(audioPath)"
                } else {
                    fullAudioUrl = nil
                }
                print("[Bridge] Reply: \(replyText.prefix(80))...")
                self.onReply?(replyText, fullAudioUrl)

            case "thinking":
                let thinkText = json["text"] as? String ?? ""
                self.onThinking?(thinkText)

            case "request_snapshot":
                // Server-initiated pull: capture and upload a fresh image
                // with this request_id so the agent's get_camera_snapshot
                // tool call resolves.
                let requestId = json["request_id"] as? String ?? ""
                let source = json["source"] as? String ?? "iphone"
                let prompt = json["prompt"] as? String
                guard !requestId.isEmpty else { break }
                print("[Bridge] Snapshot requested: \(requestId) source=\(source)")
                self.onSnapshotRequest?(requestId, source, prompt)

            case "request_voice":
                // Server-initiated pull: speak the prompt (the server has
                // already sent a `reply` message with the audio_url), then
                // start STT and post the transcript back with this id.
                let requestId = json["request_id"] as? String ?? ""
                let prompt = json["prompt"] as? String ?? ""
                let timeoutMs = json["timeout_ms"] as? Int ?? 30000
                guard !requestId.isEmpty else { break }
                print("[Bridge] Voice input requested: \(requestId) prompt=\"\(prompt.prefix(40))…\"")
                self.onVoiceRequest?(requestId, prompt, timeoutMs)

            default:
                break
            }
        }
    }

    // MARK: - Send Messages

    /// Send text + optional image via WebSocket (channel mode)
    func sendMessage(text: String, image: Data? = nil, source: String = "iphone") {
        guard mode == .channel else {
            // Fallback to REST
            Task { try? await chatREST(text: text, images: image.map { [$0] } ?? []) }
            return
        }

        var payload: [String: Any] = [
            "id": "ios-\(Date().timeIntervalSince1970)",
            "text": text,
            "source": source,
        ]

        if let imageData = image {
            payload["image"] = imageData.base64EncodedString()
        }

        guard let jsonData = try? JSONSerialization.data(withJSONObject: payload),
              let jsonString = String(data: jsonData, encoding: .utf8) else { return }

        webSocket?.send(.string(jsonString)) { error in
            if let error {
                print("[Bridge] WebSocket send error: \(error)")
            }
        }

        print("[Bridge] Sent: \"\(text.prefix(60))\" source=\(source) image=\(image != nil)")
    }

    /// Upload image via HTTP multipart (for large images, avoids base64 bloat over WS)
    func uploadImage(text: String, image: Data, source: String = "iphone") async throws {
        let url = URL(string: "http://\(config.gatewayHost):\(config.gatewayPort)/upload")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        if !config.channelToken.isEmpty {
            request.setValue("Bearer \(config.channelToken)", forHTTPHeaderField: "Authorization")
        }

        let boundary = "VisionClaude-\(UUID().uuidString)"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        let fields: [(String, String)] = [
            ("id", "ios-\(Date().timeIntervalSince1970)"),
            ("text", text),
            ("source", source),
        ]
        for (key, value) in fields {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"\(key)\"\r\n\r\n".data(using: .utf8)!)
            body.append("\(value)\r\n".data(using: .utf8)!)
        }
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"image\"; filename=\"frame.jpg\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: image/jpeg\r\n\r\n".data(using: .utf8)!)
        body.append(image)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)

        request.httpBody = body

        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 204 else {
            throw ClaudeBridgeError.serverError(statusCode: (response as? HTTPURLResponse)?.statusCode ?? 0, message: "Upload failed")
        }
        print("[Bridge] Uploaded \(source) image (\(image.count / 1024)KB)")
    }

    // MARK: - Cowork pull-pattern fulfilment

    /// Send a snapshot back to the channel server tagged with the request_id
    /// from the matching `request_snapshot` message. Resolves the agent's
    /// `get_camera_snapshot` MCP tool call.
    func fulfilSnapshot(requestId: String, image: Data, source: String = "iphone") async throws {
        let url = URL(string: "http://\(config.gatewayHost):\(config.gatewayPort)/upload")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        if !config.channelToken.isEmpty {
            request.setValue("Bearer \(config.channelToken)", forHTTPHeaderField: "Authorization")
        }

        let boundary = "VisionClaude-\(UUID().uuidString)"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        let fields: [(String, String)] = [
            ("id", "ios-snap-\(Date().timeIntervalSince1970)"),
            ("source", source),
            ("request_id", requestId),
        ]
        for (key, value) in fields {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"\(key)\"\r\n\r\n".data(using: .utf8)!)
            body.append("\(value)\r\n".data(using: .utf8)!)
        }
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"image\"; filename=\"snapshot.jpg\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: image/jpeg\r\n\r\n".data(using: .utf8)!)
        body.append(image)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)

        request.httpBody = body

        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 204 else {
            throw ClaudeBridgeError.serverError(statusCode: (response as? HTTPURLResponse)?.statusCode ?? 0, message: "Snapshot fulfilment failed")
        }
        print("[Bridge] Fulfilled snapshot \(requestId) (\(image.count / 1024)KB)")
    }

    /// Send a transcribed voice reply tagged with the request_id from the
    /// matching `request_voice` message. Resolves the agent's
    /// `request_voice_input` MCP tool call.
    func fulfilVoice(requestId: String, text: String, source: String = "iphone") async throws {
        let url = URL(string: "http://\(config.gatewayHost):\(config.gatewayPort)/message")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !config.channelToken.isEmpty {
            request.setValue("Bearer \(config.channelToken)", forHTTPHeaderField: "Authorization")
        }

        let payload: [String: Any] = [
            "request_id": requestId,
            "text": text,
            "source": source,
            "id": "ios-voice-\(Date().timeIntervalSince1970)",
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)

        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw ClaudeBridgeError.serverError(statusCode: (response as? HTTPURLResponse)?.statusCode ?? 0, message: "Voice fulfilment failed")
        }
        print("[Bridge] Fulfilled voice \(requestId): \"\(text.prefix(60))\"")
    }

    // MARK: - Gateway Mode (REST fallback)

    func chatREST(text: String, images: [Data] = []) async throws -> ChatResponse {
        let base64Images = images.map { $0.base64EncodedString() }
        let request = ChatRequest(text: text, images: base64Images, conversation_id: conversationId)

        var urlRequest = URLRequest(url: config.chatURL)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.timeoutInterval = 60
        urlRequest.httpBody = try JSONEncoder().encode(request)

        let (data, response) = try await URLSession.shared.data(for: urlRequest)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let body = String(data: data, encoding: .utf8) ?? "Unknown error"
            throw ClaudeBridgeError.serverError(statusCode: (response as? HTTPURLResponse)?.statusCode ?? 0, message: body)
        }

        let chatResponse = try JSONDecoder().decode(ChatResponse.self, from: data)
        conversationId = chatResponse.conversation_id
        return chatResponse
    }

    func checkHealth() async throws -> HealthResponse {
        let url = config.healthURL
        let (data, _) = try await URLSession.shared.data(from: url)
        return try JSONDecoder().decode(HealthResponse.self, from: data)
    }

    // MARK: - Reconnection

    private func attemptReconnect() {
        guard !isManualDisconnect, reconnectAttempts < maxReconnectAttempts else {
            print("[Bridge] Giving up reconnection after \(reconnectAttempts) attempts")
            return
        }
        reconnectAttempts += 1
        let delay = min(Double(reconnectAttempts) * 2.0, 10.0)
        print("[Bridge] Reconnecting in \(delay)s (attempt \(reconnectAttempts))")
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.connectWebSocket()
        }
    }

    private func startPingTimer() {
        pingTimer?.invalidate()
        pingTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            self?.webSocket?.sendPing { error in
                if let error {
                    print("[Bridge] Ping failed: \(error)")
                }
            }
        }
    }

    // MARK: - URLSessionWebSocketDelegate

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol proto: String?) {
        print("[Bridge] WebSocket opened")
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        print("[Bridge] WebSocket closed: \(closeCode)")
        DispatchQueue.main.async { [weak self] in
            self?.isConnected = false
            self?.attemptReconnect()
        }
    }

    func resetConversation() {
        conversationId = nil
    }
}

enum ClaudeBridgeError: LocalizedError {
    case invalidResponse
    case serverError(statusCode: Int, message: String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "Invalid response from server"
        case .serverError(let code, let message):
            return "Server error (\(code)): \(message)"
        }
    }
}
