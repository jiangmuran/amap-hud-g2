#!/bin/bash
# 内网预览：手机端（Vite）+ 官方模拟器（Xtigervnc 虚拟显示 + noVNC 网页查看）
# 用法：scripts/lan-preview.sh start|stop|status
#   SIM_QUERY='?demo=walking' scripts/lan-preview.sh start   # 模拟器启动即进入演示导航
set -u
cd "$(dirname "$0")/.."
IP=$(ip -4 -o addr show | awk '$2!="lo" && $4 ~ /^192\.168\./ {split($4,a,"/"); print a[1]; exit}')
RUN=$HOME/.local/preview-run; mkdir -p "$RUN"
DISP=:99; VNC_PORT=5911; WEB_PORT=6081; VITE_PORT=5173
SIM=$HOME/.local/simlibs/run-sim.sh
NOVNC=$HOME/.local/novnc
TVNC=$HOME/.local/tigervnc/root

# 在新会话中启动，并记录真实 PID（bash 记下自己的 PID 后 exec 成目标进程）
spawn() { # name cmd...
  local name=$1; shift
  setsid bash -c 'echo $$ > "$0"; exec "$@"' "$RUN/$name.pid" "$@" > "$RUN/$name.log" 2>&1 < /dev/null &
}
stopone() {
  local f="$RUN/$1.pid"
  [ -f "$f" ] || return 0
  local pid; pid=$(cat "$f")
  kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null
  rm -f "$f"
}

case "${1:-start}" in
  start)
    "$0" stop >/dev/null 2>&1
    sleep 1
    # webkit 子进程路径的等长软链（/tmp 被清理后需要重建）
    ln -sfn "$HOME/.local/simlibs/root/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1" /tmp/wk2gtk41xxxxxxxxxxxxxxxxxxxxxxxxxxx
    HMR_HOST=$IP spawn vite npx vite --host 0.0.0.0 --port $VITE_PORT --strictPort
    LD_LIBRARY_PATH=$TVNC/usr/lib/x86_64-linux-gnu spawn xvnc "$TVNC/usr/bin/Xtigervnc" $DISP \
      -geometry 1440x960 -depth 24 -rfbport $VNC_PORT -localhost -SecurityTypes None -AlwaysShared \
      -xkbdir /usr/share/X11/xkb
    sleep 2
    DISPLAY=$DISP spawn sim "$SIM" "http://127.0.0.1:$VITE_PORT/${SIM_QUERY:-}" --automation-port 9898 --no-glow
    spawn novnc websockify --web "$NOVNC" 0.0.0.0:$WEB_PORT 127.0.0.1:$VNC_PORT
    sleep 5
    "$0" status
    ;;
  stop)
    for n in novnc sim xvnc vite; do stopone $n; done
    echo stopped
    ;;
  status)
    chk() { printf '%-4s %s\n' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$1")" "$1"; }
    chk "http://$IP:$VITE_PORT/"
    chk "http://$IP:$WEB_PORT/vnc.html"
    chk "http://127.0.0.1:9898/api/ping"
    echo
    echo "手机端预览:   http://$IP:$VITE_PORT/?mock=1"
    echo "官方模拟器:   http://$IP:$WEB_PORT/vnc.html?autoconnect=1&resize=scale"
    ;;
esac
