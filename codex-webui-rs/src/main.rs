use anyhow::Context;
use anyhow::Result;
use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::extract::WebSocketUpgrade;
use axum::extract::ws::Message;
use axum::extract::ws::WebSocket;
use axum::response::IntoResponse;
use axum::routing::get;
use futures_util::SinkExt;
use futures_util::StreamExt;
use serde_json::Value;
use serde_json::json;
use std::collections::VecDeque;
use std::env;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;
use tokio::net::TcpStream;
use tokio::process::Child;
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::sync::broadcast;
use tokio::sync::mpsc;
use tower_http::services::ServeDir;
use tracing::debug;
use tracing::info;
use tracing::warn;
use uuid::Uuid;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "codex_webui_rs=info".into()),
        )
        .init();

    let config = Arc::new(Config::from_env()?);
    let (shutdown_tx, mut shutdown_rx) = broadcast::channel::<()>(8);
    let prewarmed_runtime = Arc::new(Mutex::new(None));
    let app_state = Arc::new(AppState {
        config,
        shutdown_tx,
        prewarmed_runtime,
    });

    let static_service =
        ServeDir::new(app_state.config.static_dir.clone()).append_index_html_on_directories(true);

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/ws", get(ws_handler))
        .fallback_service(static_service)
        .with_state(app_state.clone());

    let bind_addr = format!("{}:{}", app_state.config.host, app_state.config.port);
    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .with_context(|| format!("failed to bind {bind_addr}"))?;

    info!("codex-webui-rs listening on http://{bind_addr}");
    info!("backend mode: tui-control");
    info!("codex command: {}", app_state.config.codex_command);
    info!("codex cwd: {}", app_state.config.codex_cwd.display());
    info!(
        "exit server on tui exit: {}",
        app_state.config.exit_server_on_tui_exit
    );
    info!(
        "prestart tui on server start: {}",
        app_state.config.prestart_tui_on_server_start
    );
    info!("tip: set CODEX_COMMAND to a full path if codex-news is not on PATH");
    if app_state.config.prestart_tui_on_server_start {
        match connect_interactive_codex(app_state.config.as_ref()).await {
            Ok(runtime) => {
                info!(
                    "interactive codex prestarted on {}",
                    runtime.control_addr_text
                );
                let mut prewarmed_runtime = app_state.prewarmed_runtime.lock().await;
                *prewarmed_runtime = Some(runtime);
            }
            Err(err) => {
                warn!(
                    "failed to prestart interactive codex; will start lazily on first client: {err}"
                );
            }
        }
    }

    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.recv().await;
        })
        .await
        .context("axum server crashed")?;
    Ok(())
}

#[derive(Clone)]
struct AppState {
    config: Arc<Config>,
    shutdown_tx: broadcast::Sender<()>,
    prewarmed_runtime: Arc<Mutex<Option<ConnectedRuntime>>>,
}

async fn healthz(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({
        "ok": true,
        "backendMode": "tui-control",
        "host": state.config.host,
        "port": state.config.port,
    }))
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(state, socket))
}

async fn handle_socket(state: Arc<AppState>, socket: WebSocket) {
    let session_id = Uuid::new_v4().to_string();
    debug!("ws connected: session={}", truncate_id(&session_id, 8));
    let (mut ws_sender, mut ws_receiver) = socket.split();

    let (ws_out_tx, mut ws_out_rx) = mpsc::unbounded_channel::<Value>();
    let writer_session_id = session_id.clone();
    let writer_task = tokio::spawn(async move {
        while let Some(payload) = ws_out_rx.recv().await {
            let text = payload.to_string();
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                if let Some(message_type) = value.get("type").and_then(|value| value.as_str()) {
                    debug!(
                        "ws->client: session={} type={message_type}",
                        truncate_id(&writer_session_id, 8)
                    );
                }
            }
            if ws_sender.send(Message::Text(text.into())).await.is_err() {
                warn!(
                    "ws writer closed: session={}",
                    truncate_id(&writer_session_id, 8)
                );
                break;
            }
        }
    });

    let (event_tx, event_rx) = mpsc::unbounded_channel::<SessionEvent>();
    let reader_tx = event_tx.clone();
    let reader_session_id = session_id.clone();
    let reader_task = tokio::spawn(async move {
        while let Some(message) = ws_receiver.next().await {
            match message {
                Ok(Message::Text(text)) => {
                    let command = parse_client_command(text.as_ref());
                    debug!(
                        "ws<-client: session={} command={}",
                        truncate_id(&reader_session_id, 8),
                        summarize_client_command(&command)
                    );
                    if reader_tx.send(SessionEvent::Client(command)).is_err() {
                        return;
                    }
                }
                Ok(Message::Close(_)) => {
                    debug!(
                        "ws close frame: session={}",
                        truncate_id(&reader_session_id, 8)
                    );
                    let _ = reader_tx.send(SessionEvent::SocketClosed);
                    return;
                }
                Ok(_) => {}
                Err(err) => {
                    warn!(
                        "ws read error: session={} error={err}",
                        truncate_id(&reader_session_id, 8)
                    );
                    let _ = reader_tx.send(SessionEvent::Client(ClientCommand::Invalid(format!(
                        "WebSocket read error: {err}"
                    ))));
                    let _ = reader_tx.send(SessionEvent::SocketClosed);
                    return;
                }
            }
        }
        let _ = reader_tx.send(SessionEvent::SocketClosed);
    });

    let mut session = SessionCore {
        id: session_id,
        runtime: None,
        ws_tx: ws_out_tx,
        event_tx,
        event_rx,
        pending_client_commands: VecDeque::new(),
        config: state.config.clone(),
        shutdown_tx: state.shutdown_tx.clone(),
        prewarmed_runtime: state.prewarmed_runtime.clone(),
    };

    session.emit(json!({
        "type": "connected",
        "backend": "tui-control",
        "sessionId": session.id,
        "threadId": Value::Null,
    }));

    if let Err(err) = session.ensure_tui_runtime().await {
        session.emit_error(format!("Failed to initialize TUI backend: {err}"));
    }

    let mut poll_interval = tokio::time::interval(Duration::from_millis(200));
    loop {
        if let Some(command) = session.pending_client_commands.pop_front() {
            if !session.handle_client_command(command).await {
                break;
            }
            continue;
        }

        tokio::select! {
            _ = poll_interval.tick() => {
                match session.poll_tui_exit().await {
                    Ok(should_continue) => {
                        if !should_continue {
                            break;
                        }
                    }
                    Err(err) => {
                        session.emit_error(format!("Failed to poll TUI exit: {err}"));
                    }
                }
            }
            event = session.event_rx.recv() => {
                let Some(event) = event else { break; };
                if !session.handle_session_event(event).await {
                    break;
                }
            }
        }
    }

    if let Err(err) = session.shutdown_tui_runtime().await {
        session.emit_error(format!("Failed to shut down TUI runtime: {err}"));
    }
    debug!("ws disconnected: session={}", truncate_id(&session.id, 8));

    drop(session.ws_tx);
    let _ = reader_task.await;
    let _ = writer_task.await;
}

#[derive(Debug)]
enum SessionEvent {
    Client(ClientCommand),
    ControlLine(String),
    ControlClosed,
    SocketClosed,
}

#[derive(Debug)]
enum ClientCommand {
    Prompt(String),
    Cancel,
    ResetThread,
    Invalid(String),
}

struct TuiRuntime {
    child: Child,
    control_writer: tokio::net::tcp::OwnedWriteHalf,
}

struct ConnectedRuntime {
    child: Child,
    control_stream: TcpStream,
    control_addr_text: String,
}

struct SessionCore {
    id: String,
    runtime: Option<TuiRuntime>,
    ws_tx: mpsc::UnboundedSender<Value>,
    event_tx: mpsc::UnboundedSender<SessionEvent>,
    event_rx: mpsc::UnboundedReceiver<SessionEvent>,
    pending_client_commands: VecDeque<ClientCommand>,
    config: Arc<Config>,
    shutdown_tx: broadcast::Sender<()>,
    prewarmed_runtime: Arc<Mutex<Option<ConnectedRuntime>>>,
}

impl SessionCore {
    fn emit(&self, payload: Value) {
        let _ = self.ws_tx.send(payload);
    }

    fn emit_error(&self, message: String) {
        self.emit(json!({
            "type": "error",
            "message": message,
        }));
    }

    async fn handle_session_event(&mut self, event: SessionEvent) -> bool {
        match event {
            SessionEvent::SocketClosed => {
                debug!(
                    "session socket closed: session={}",
                    truncate_id(&self.id, 8)
                );
                false
            }
            SessionEvent::Client(command) => self.handle_client_command(command).await,
            SessionEvent::ControlLine(line) => {
                self.forward_control_line(line);
                true
            }
            SessionEvent::ControlClosed => {
                warn!(
                    "control channel closed: session={}",
                    truncate_id(&self.id, 8)
                );
                self.emit_error("TUI control channel closed".to_string());
                self.runtime = None;
                true
            }
        }
    }

    fn forward_control_line(&self, line: String) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return;
        }

        match serde_json::from_str::<Value>(trimmed) {
            Ok(payload) => {
                let message_type = payload
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                debug!(
                    "control->ws: session={} type={message_type}",
                    truncate_id(&self.id, 8)
                );
                self.emit(payload);
            }
            Err(_) => {
                debug!(
                    "control->ws raw line: session={} text={}",
                    truncate_id(&self.id, 8),
                    truncate_text(trimmed, 120)
                );
                self.emit(json!({
                    "type": "codex_raw",
                    "text": trimmed,
                }));
            }
        }
    }

    async fn handle_client_command(&mut self, command: ClientCommand) -> bool {
        match command {
            ClientCommand::Prompt(prompt) => {
                if prompt.trim().is_empty() {
                    self.emit_error("Prompt cannot be empty".to_string());
                    return true;
                }
                debug!(
                    "submit prompt: session={} len={}",
                    truncate_id(&self.id, 8),
                    prompt.chars().count()
                );
                if let Err(err) = self
                    .send_control_command(json!({
                        "type": "prompt",
                        "prompt": prompt,
                    }))
                    .await
                {
                    self.emit_error(format!("Request failed: {err}"));
                }
                true
            }
            ClientCommand::Cancel => {
                debug!("submit cancel: session={}", truncate_id(&self.id, 8));
                if let Err(err) = self.send_control_command(json!({ "type": "cancel" })).await {
                    self.emit_error(format!("Request failed: {err}"));
                }
                true
            }
            ClientCommand::ResetThread => {
                debug!("submit reset_thread: session={}", truncate_id(&self.id, 8));
                if let Err(err) = self
                    .send_control_command(json!({ "type": "reset_thread" }))
                    .await
                {
                    self.emit_error(format!("Request failed: {err}"));
                }
                true
            }
            ClientCommand::Invalid(message) => {
                self.emit_error(message);
                true
            }
        }
    }

    async fn send_control_command(&mut self, payload: Value) -> Result<()> {
        self.ensure_tui_runtime().await?;
        let runtime = self
            .runtime
            .as_mut()
            .context("TUI runtime is unavailable")?;
        debug!(
            "ws->control: session={} type={}",
            truncate_id(&self.id, 8),
            payload
                .get("type")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown")
        );
        write_json_line(&mut runtime.control_writer, &payload).await
    }

    async fn ensure_tui_runtime(&mut self) -> Result<()> {
        if self.runtime.is_some() {
            return Ok(());
        }

        let connected_runtime = {
            let mut prewarmed_runtime = self.prewarmed_runtime.lock().await;
            prewarmed_runtime.take()
        };
        let connected_runtime = if let Some(runtime) = connected_runtime {
            debug!(
                "using prestarted interactive codex: session={} control={}",
                truncate_id(&self.id, 8),
                runtime.control_addr_text
            );
            runtime
        } else {
            debug!(
                "starting interactive codex: session={}",
                truncate_id(&self.id, 8)
            );
            connect_interactive_codex(self.config.as_ref()).await?
        };
        debug!(
            "control connected: session={} control={}",
            truncate_id(&self.id, 8),
            connected_runtime.control_addr_text
        );
        let (control_reader, control_writer) = connected_runtime.control_stream.into_split();

        let event_tx = self.event_tx.clone();
        tokio::spawn(async move {
            read_control_lines(control_reader, event_tx).await;
        });

        self.runtime = Some(TuiRuntime {
            child: connected_runtime.child,
            control_writer,
        });

        self.emit(json!({
            "type": "backend_ready",
            "backend": "tui-control",
        }));

        Ok(())
    }

    async fn poll_tui_exit(&mut self) -> Result<bool> {
        let Some(runtime) = self.runtime.as_mut() else {
            return Ok(true);
        };

        let Some(status) = runtime.child.try_wait()? else {
            return Ok(true);
        };
        warn!(
            "interactive codex exited: session={} code={:?} signal={:?}",
            truncate_id(&self.id, 8),
            status.code(),
            exit_signal(&status)
        );

        self.emit_error(format!(
            "interactive codex exited (code: {:?}, signal: {:?})",
            status.code(),
            exit_signal(&status)
        ));
        self.runtime = None;
        if self.config.exit_server_on_tui_exit {
            info!(
                "interactive codex requested exit; shutting down web server: session={}",
                truncate_id(&self.id, 8)
            );
            let _ = self.shutdown_tx.send(());
            return Ok(false);
        }
        Ok(true)
    }

    async fn shutdown_tui_runtime(&mut self) -> Result<()> {
        if let Some(mut runtime) = self.runtime.take() {
            let _ = runtime.child.start_kill();
            let _ = runtime.child.wait().await;
        }
        Ok(())
    }
}

async fn reserve_control_addr() -> Result<std::net::SocketAddr> {
    let probe = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .context("failed to reserve local control address")?;
    let addr = probe
        .local_addr()
        .context("failed to read local control address")?;
    drop(probe);
    Ok(addr)
}

async fn connect_interactive_codex(config: &Config) -> Result<ConnectedRuntime> {
    let control_addr = reserve_control_addr().await?;
    let control_addr_text = control_addr.to_string();
    let mut child = Command::new(&config.codex_command)
        .args(&config.codex_args)
        .current_dir(&config.codex_cwd)
        .env("CODEX_TUI_CONTROL_LISTEN", &control_addr_text)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .with_context(|| format!("failed to spawn {}", config.codex_command))?;
    let control_stream = connect_control_with_retry(control_addr, &mut child).await?;
    Ok(ConnectedRuntime {
        child,
        control_stream,
        control_addr_text,
    })
}

async fn connect_control_with_retry(
    addr: std::net::SocketAddr,
    child: &mut Child,
) -> Result<TcpStream> {
    let mut attempts = 0_u32;
    loop {
        attempts += 1;
        match TcpStream::connect(addr).await {
            Ok(stream) => return Ok(stream),
            Err(err) => {
                if let Some(status) = child.try_wait()? {
                    return Err(anyhow::anyhow!(
                        "codex exited before control channel was ready (code: {:?}, signal: {:?})",
                        status.code(),
                        exit_signal(&status)
                    ));
                }

                if attempts >= 80 {
                    return Err(anyhow::anyhow!(
                        "failed to connect to control channel {addr} after {attempts} attempts: {err}"
                    ));
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

async fn read_control_lines(
    reader: tokio::net::tcp::OwnedReadHalf,
    event_tx: mpsc::UnboundedSender<SessionEvent>,
) {
    let mut lines = BufReader::new(reader).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                if let Ok(payload) = serde_json::from_str::<Value>(&line) {
                    if let Some(message_type) = payload.get("type").and_then(|value| value.as_str())
                    {
                        debug!("control line type={message_type}");
                    }
                }
                if event_tx.send(SessionEvent::ControlLine(line)).is_err() {
                    return;
                }
            }
            Ok(None) => {
                warn!("control stream ended");
                let _ = event_tx.send(SessionEvent::ControlClosed);
                return;
            }
            Err(err) => {
                warn!("failed to read control stream: {err}");
                let _ = event_tx.send(SessionEvent::ControlClosed);
                return;
            }
        }
    }
}

async fn write_json_line(
    writer: &mut tokio::net::tcp::OwnedWriteHalf,
    payload: &Value,
) -> Result<()> {
    let line = serde_json::to_string(payload).context("failed to serialize control command")?;
    writer
        .write_all(format!("{line}\n").as_bytes())
        .await
        .context("failed to write control command")?;
    writer
        .flush()
        .await
        .context("failed to flush control command")
}

fn parse_client_command(raw_text: &str) -> ClientCommand {
    let payload: Value = match serde_json::from_str(raw_text) {
        Ok(value) => value,
        Err(_) => return ClientCommand::Invalid("Invalid JSON payload".to_string()),
    };

    let message_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
    match message_type {
        "prompt" => {
            let prompt = payload
                .get("prompt")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            ClientCommand::Prompt(prompt)
        }
        "cancel" => ClientCommand::Cancel,
        "reset_thread" => ClientCommand::ResetThread,
        _ => ClientCommand::Invalid(format!("Unknown message type: {message_type}")),
    }
}

fn summarize_client_command(command: &ClientCommand) -> String {
    match command {
        ClientCommand::Prompt(prompt) => format!("prompt(len={})", prompt.chars().count()),
        ClientCommand::Cancel => "cancel".to_string(),
        ClientCommand::ResetThread => "reset_thread".to_string(),
        ClientCommand::Invalid(message) => format!("invalid({})", truncate_text(message, 120)),
    }
}

fn truncate_id(value: &str, head: usize) -> String {
    if value.chars().count() <= head {
        return value.to_string();
    }
    let prefix: String = value.chars().take(head).collect();
    format!("{prefix}...")
}

fn truncate_text(value: &str, max_chars: usize) -> String {
    let char_count = value.chars().count();
    if char_count <= max_chars {
        return value.to_string();
    }
    let prefix: String = value.chars().take(max_chars).collect();
    format!("{prefix}...(len={char_count})")
}

#[cfg(unix)]
fn exit_signal(status: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn exit_signal(_status: &std::process::ExitStatus) -> Option<i32> {
    None
}

#[derive(Clone)]
struct Config {
    host: String,
    port: u16,
    codex_command: String,
    codex_cwd: PathBuf,
    codex_args: Vec<String>,
    static_dir: PathBuf,
    exit_server_on_tui_exit: bool,
    prestart_tui_on_server_start: bool,
}

impl Config {
    fn from_env() -> Result<Self> {
        let host = env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let port = env::var("PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(8787);

        let codex_command = env::var("CODEX_COMMAND").unwrap_or_else(|_| default_codex_command());
        let codex_cwd = env::var("CODEX_CWD")
            .map(PathBuf::from)
            .unwrap_or_else(|_| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

        let codex_args_raw = env::var("CODEX_ARGS")
            .or_else(|_| env::var("CODEX_TUI_ARGS"))
            .unwrap_or_default();
        let codex_args = parse_cli_args(&codex_args_raw);

        let static_dir = env::var("CODEX_WEBUI_STATIC_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("public"));
        let exit_server_on_tui_exit =
            parse_exit_server_on_tui_exit(env::var("EXIT_SERVER_ON_TUI_EXIT").ok().as_deref());
        let prestart_tui_on_server_start = parse_prestart_tui_on_server_start(
            env::var("PRESTART_TUI_ON_SERVER_START").ok().as_deref(),
        );

        Ok(Self {
            host,
            port,
            codex_command,
            codex_cwd,
            codex_args,
            static_dir,
            exit_server_on_tui_exit,
            prestart_tui_on_server_start,
        })
    }
}

fn parse_prestart_tui_on_server_start(value: Option<&str>) -> bool {
    parse_switch(value, true)
}

fn parse_exit_server_on_tui_exit(value: Option<&str>) -> bool {
    parse_switch(value, false)
}

fn parse_switch(value: Option<&str>, default_value: bool) -> bool {
    let Some(value) = value.map(str::trim) else {
        return default_value;
    };
    if value.is_empty() {
        return default_value;
    }
    if value == "1"
        || value.eq_ignore_ascii_case("true")
        || value.eq_ignore_ascii_case("yes")
        || value.eq_ignore_ascii_case("on")
    {
        return true;
    }
    if value == "0"
        || value.eq_ignore_ascii_case("false")
        || value.eq_ignore_ascii_case("no")
        || value.eq_ignore_ascii_case("off")
    {
        return false;
    }
    default_value
}

fn default_codex_command() -> String {
    let local_debug_binary = if cfg!(windows) {
        PathBuf::from("..")
            .join("codex-rs")
            .join("target")
            .join("debug")
            .join("codex-news.exe")
    } else {
        PathBuf::from("../codex-rs/target/debug/codex-news")
    };

    if local_debug_binary.is_file() {
        return local_debug_binary.display().to_string();
    }

    "codex-news".to_string()
}

fn parse_cli_args(raw: &str) -> Vec<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    if let Ok(parsed) = serde_json::from_str::<Vec<String>>(trimmed) {
        return parsed;
    }

    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;

    for ch in trimmed.chars() {
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }

        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            continue;
        }

        if ch.is_whitespace() {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            continue;
        }

        current.push(ch);
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    tokens
}

#[cfg(test)]
mod tests {
    use super::parse_exit_server_on_tui_exit;
    use super::parse_prestart_tui_on_server_start;

    #[test]
    fn parse_exit_server_on_tui_exit_supports_common_true_values() {
        for value in ["1", "true", "TRUE", "yes", "on"] {
            assert!(parse_exit_server_on_tui_exit(Some(value)));
        }
    }

    #[test]
    fn parse_exit_server_on_tui_exit_defaults_to_false() {
        assert!(!parse_exit_server_on_tui_exit(None));
        assert!(!parse_exit_server_on_tui_exit(Some("0")));
        assert!(!parse_exit_server_on_tui_exit(Some("false")));
        assert!(!parse_exit_server_on_tui_exit(Some("off")));
        assert!(!parse_exit_server_on_tui_exit(Some("")));
    }

    #[test]
    fn parse_prestart_tui_on_server_start_defaults_to_true() {
        assert!(parse_prestart_tui_on_server_start(None));
        assert!(!parse_prestart_tui_on_server_start(Some("0")));
        assert!(!parse_prestart_tui_on_server_start(Some("false")));
        assert!(!parse_prestart_tui_on_server_start(Some("off")));
    }
}
