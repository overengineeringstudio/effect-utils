# Context example tasks
#
# Usage in devenv.nix:
#   imports = [ ./nix/devenv-modules/tasks/context.nix ];
#
# Provides: context:examples
{ ... }:
{
  tasks = {
    "context:examples" = {
      description = "Run all context socket example scripts";
      exec = ''
        set -e
        SOCKET_DIR="$WORKSPACE_ROOT/context/effect/socket"
        
        run_with_server() {
          local label="$1"
          local server_script="$2"
          shift 2
          
          echo "::group::$label"
          
          # Start server in background
          bun "$SOCKET_DIR/$server_script" &
          SERVER_PID=$!
          trap "kill $SERVER_PID 2>/dev/null || true" EXIT
          
          # Wait for server to start
          sleep 1
          
          # Run client commands
          "$@"
          
          # Stop server
          kill $SERVER_PID 2>/dev/null || true
          trap - EXIT
          
          echo "::endgroup::"
        }
        
        # WS echo
        run_with_server "WS echo" "examples/ws-echo-server.ts" \
          bun "$SOCKET_DIR/examples/ws-echo-client.ts"
        
        # WS broadcast
        run_with_server "WS broadcast" "examples/ws-broadcast-server.ts" \
          bun "$SOCKET_DIR/examples/ws-broadcast-client.ts"
        
        # WS JSON
        run_with_server "WS JSON" "examples/ws-json-server.ts" \
          bun "$SOCKET_DIR/examples/ws-json-client.ts"
        
        # HTTP + WS combined
        run_with_server "HTTP + WS combined" "examples/http-ws-combined.ts" \
          bash -c "curl -s http://127.0.0.1:8788/ && bun -e 'const ws = new WebSocket(\"ws://127.0.0.1:8790\"); const timeout = setTimeout(() => { console.error(\"timeout waiting for message\"); ws.close(); process.exit(1) }, 2000); ws.onopen = () => ws.send(\"hello\"); ws.onmessage = (event) => { console.log(\"recv\", event.data); clearTimeout(timeout); ws.close() }; ws.onclose = () => process.exit(0); ws.onerror = (error) => { console.error(error); clearTimeout(timeout); process.exit(1) }'"
        
        # RPC over WebSocket
        run_with_server "RPC over WebSocket" "examples/rpc-ws-server.ts" \
          bun "$SOCKET_DIR/examples/rpc-ws-client.ts"
        
        # TCP echo
        run_with_server "TCP echo" "examples/tcp-echo-server.ts" \
          bun "$SOCKET_DIR/examples/tcp-echo-client.ts"
        
        echo "✓ Context examples complete"
      '';
    };
  };
}
