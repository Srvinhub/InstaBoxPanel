import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Copy, Maximize2, Minimize2, Minus, Plus, RefreshCw, X, ClipboardPaste, TerminalSquare } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { isDemo } from './api';
import type { MachineRow } from './App';
import { useFloatingWindow } from './useFloatingWindow';

export default function TerminalPane({ row, control, onClose, index, active, onActivate }: { row: MachineRow; control: ReactNode; onClose: () => void; index: number; active: boolean; onActivate: () => void }) {
  const mount=useRef<HTMLDivElement>(null), term=useRef<Terminal|null>(null), socket=useRef<WebSocket|null>(null);
  const titleId=useId(), floating=useFloatingWindow(index), resizeTerminal=useRef<()=>void>(()=>{});
  const [status,setStatus]=useState('等待连接'),[error,setError]=useState(''),[attempt,setAttempt]=useState(0),[fontSize,setFontSize]=useState(13);
  const [connected,setConnected]=useState(false);
  const canConnect=row.machine.state==='running'&&row.account.enabled;
  useEffect(()=>{
    if(!canConnect||!mount.current)return;
    let disposed=false;
    setError('');setStatus(isDemo?'已连接 · 演示会话':'正在连接');setConnected(isDemo);
    const terminal=new Terminal({cursorBlink:true,fontSize,disableStdin:!isDemo,fontFamily:'Consolas, "Cascadia Code", "Courier New", monospace',scrollback:5000,screenReaderMode:true,allowProposedApi:false,
      theme:{background:'#17221f',foreground:'#d6e3d9',cursor:'#bdd8c0',selectionBackground:'#59756380',black:'#22332a',red:'#e68a78',green:'#a6d493',yellow:'#dbc38a',blue:'#91b4cd',magenta:'#c7a6cf',cyan:'#91c9bc',white:'#dbe5d9',brightBlack:'#7a9284',brightRed:'#efac9d',brightGreen:'#c1e8aa',brightYellow:'#f0d59f',brightBlue:'#b2d2e8',brightMagenta:'#dec4e1',brightCyan:'#b6e1d5',brightWhite:'#f0f5ef'}});
    const fit=new FitAddon();terminal.loadAddon(fit);terminal.open(mount.current);term.current=terminal;
    // Ignore remote clipboard escape sequences. Copy/paste is a local user action.
    terminal.parser.registerOscHandler(52,()=>true);
    let resizeFrame=0;
    const resize=()=>{cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(()=>{if(disposed||!mount.current?.clientHeight)return;fit.fit();if(socket.current?.readyState===WebSocket.OPEN)socket.current.send(JSON.stringify({type:'resize',cols:Math.max(10,Math.min(1000,terminal.cols)),rows:Math.max(4,Math.min(500,terminal.rows))}));});};
    resizeTerminal.current=resize;
    const observer=new ResizeObserver(resize);observer.observe(mount.current);resize();terminal.focus();
    const onFocus=()=>resize();window.addEventListener('resize',onFocus);
    const encoder=new TextEncoder();
    let input='';
    let dataSubscription:{dispose:()=>void}|undefined,binarySubscription:{dispose:()=>void}|undefined;
    if(isDemo){
      terminal.writeln('\x1b[1;32mInstaBox Panel\x1b[0m  ·  交互终端演示');
      terminal.writeln('这不是远端连接。可试用 help、ls、pwd、clear 与 Ctrl+C。\r\n');
      const prompt=()=>terminal.write('\x1b[32mdemo\x1b[0m:\x1b[34m~/workspace\x1b[0m $ ');
      prompt();
      dataSubscription=terminal.onData(data=>{
        for(const char of data){
          if(char==='\r'){terminal.write('\r\n');const cmd=input.trim();if(cmd==='clear'){terminal.clear();}else if(cmd==='ls'){terminal.writeln('\x1b[34msrc/\x1b[0m  \x1b[34mdocs/\x1b[0m  README.md  \x1b[32mstart.sh\x1b[0m');}else if(cmd==='pwd'){terminal.writeln('/data/home/workspace');}else if(cmd==='help'){terminal.writeln('help · ls · pwd · clear  |  Ctrl+C 中断 · Ctrl+L 清屏');}else if(cmd){terminal.writeln('演示模式不会执行命令。连接真实机器后可使用完整 Shell。');}input='';prompt();}
          else if(char==='\x03'){terminal.write('^C\r\n');input='';prompt();}
          else if(char==='\x0c'){terminal.clear();input='';prompt();}
          else if(char==='\x7f'){if(input.length){input=input.slice(0,-1);terminal.write('\b \b');}}
          else if(char>=' '&&char!=='\x7f'){input+=char;terminal.write(char);}
        }
      });
    }else{
      const url=new URL('/api/accounts/'+row.account.id+'/machines/'+row.machine.id+'/terminal',location.origin);
      url.protocol=url.protocol==='https:'?'wss:':'ws:';
      url.searchParams.set('cols',String(Math.max(10,Math.min(1000,terminal.cols))));
      url.searchParams.set('rows',String(Math.max(4,Math.min(500,terminal.rows))));
      const ws=new WebSocket(url);ws.binaryType='arraybuffer';socket.current=ws;
      ws.onopen=()=>{if(disposed)return;setStatus('已连接');setConnected(true);terminal.options.disableStdin=false;resize();terminal.focus();};
      ws.onmessage=event=>{
        if(disposed)return;
        if(typeof event.data!=='string'){terminal.write(new Uint8Array(event.data as ArrayBuffer));return;}
        try{
          const data=JSON.parse(event.data);
          if(data.type==='session')setStatus(data.persistent?'已连接 · 持久会话':'已连接 · 临时会话');
          else if(data.type==='exit'){setStatus('Shell 已退出（'+data.code+'）');setConnected(false);terminal.options.disableStdin=true;}
          else if(data.type==='taken'){setStatus('会话已在其他页面打开');setConnected(false);terminal.options.disableStdin=true;}
          else if(data.type==='error'){setStatus('连接异常');setConnected(false);setError('远端终端报告错误，请检查机器状态后重新连接。');terminal.options.disableStdin=true;ws.close();}
        }catch{setError('收到了无法识别的终端消息。');}
      };
      const send=(bytes:Uint8Array)=>{
        if(ws.readyState!==WebSocket.OPEN)return;
        if(ws.bufferedAmount>512*1024){setError('网络积压过多，已断开；未发送的输入不会重放。');ws.close(1000,'input backlog');return;}
        ws.send(bytes);
      };
      dataSubscription=terminal.onData(data=>send(encoder.encode(data)));
      binarySubscription=terminal.onBinary(data=>send(Uint8Array.from(data,c=>c.charCodeAt(0))));
      ws.onerror=()=>{if(!disposed){setConnected(false);setError('连接失败。请确认登录有效、机器正在运行，且 Key 具备 machines:write 权限。');}};
      ws.onclose=()=>{if(!disposed){setConnected(false);setStatus(s=>s.startsWith('Shell')||s.includes('其他页面')?s:'连接已断开');terminal.options.disableStdin=true;}};
    }
    terminal.attachCustomKeyEventHandler(event=>{
      if(event.type==='keydown'&&(event.ctrlKey||event.metaKey)&&event.shiftKey&&event.code==='KeyC'){event.preventDefault();void navigator.clipboard.writeText(terminal.getSelection()).catch(()=>setError('无法复制，请检查浏览器剪贴板权限。'));return false;}
      if(event.type==='keydown'&&(event.ctrlKey||event.metaKey)&&event.shiftKey&&event.code==='KeyV'){event.preventDefault();void navigator.clipboard.readText().then(text=>terminal.paste(text)).catch(()=>setError('无法读取剪贴板，可使用系统粘贴快捷键。'));return false;}
      return true;
    });
    return()=>{disposed=true;cancelAnimationFrame(resizeFrame);resizeTerminal.current=()=>{};observer.disconnect();window.removeEventListener('resize',onFocus);dataSubscription?.dispose();binarySubscription?.dispose();socket.current?.close(1000,'panel closed');socket.current=null;terminal.dispose();term.current=null;};
  },[canConnect,row.account.id,row.machine.id,attempt]);
  useEffect(()=>{if(term.current)term.current.options.fontSize=fontSize;resizeTerminal.current();},[fontSize,attempt]);
  const sendKey=(value:string)=>{if(isDemo){term.current?.input(value,true);}else if(socket.current?.readyState===WebSocket.OPEN){socket.current.send(new TextEncoder().encode(value));}term.current?.focus();};
  const clipboard=async(paste:boolean)=>{try{if(paste)term.current?.paste(await navigator.clipboard.readText());else await navigator.clipboard.writeText(term.current?.getSelection()||'');term.current?.focus();}catch{setError('无法访问剪贴板，请使用浏览器允许的复制粘贴方式。');}};
  return <section role="dialog" aria-modal="false" className={'terminal-dialog floating-terminal'+(floating.maximized?' maximized':'')+(active?' active':'')} aria-labelledby={titleId} style={{...floating.style,zIndex:active?200:100+index}} onPointerDownCapture={onActivate} onFocusCapture={onActivate}>
    <header className="terminal-heading" {...floating.drag} onDoubleClick={event=>{if(!(event.target as HTMLElement).closest('button'))floating.toggleMaximized();}}><div className="terminal-title"><TerminalSquare size={18}/><h2 id={titleId}>{row.machine.name}</h2><span>{isDemo?'演示':row.account.label}</span></div><div className="terminal-title-actions">
      <button className="terminal-icon" aria-label="复制选中内容" onClick={()=>void clipboard(false)}><Copy size={15}/></button><button className="terminal-icon" aria-label="粘贴到终端" onClick={()=>void clipboard(true)}><ClipboardPaste size={15}/></button>
      <button className="terminal-icon" aria-label="缩小终端字体" onClick={()=>setFontSize(s=>Math.max(11,s-1))}><Minus size={15}/></button><button className="terminal-icon" aria-label="放大终端字体" onClick={()=>setFontSize(s=>Math.min(20,s+1))}><Plus size={15}/></button>
      <button className="terminal-icon" aria-label={floating.maximized?'还原终端窗口':'最大化终端窗口'} title={floating.maximized?'还原窗口':'最大化到页面'} onClick={floating.toggleMaximized}>{floating.maximized?<Minimize2 size={16}/>:<Maximize2 size={16}/>}</button>
      <button className="terminal-icon terminal-close" aria-label="关闭终端" onClick={onClose}><X size={20}/></button>
    </div></header>
    {error&&<div className="terminal-error" role="alert">{error}</div>}
    {canConnect?<div className="terminal-mount" ref={mount}/>:<div className="terminal-wait"><TerminalSquare size={34}/><p>机器运行后，可以连接它的交互终端。</p>{control}</div>}
    <footer className="terminal-footer"><div className="terminal-keys">{[['Ctrl+C','\x03'],['Ctrl+D','\x04'],['Ctrl+L','\x0c'],['Ctrl+R','\x12'],['Ctrl+W','\x17'],['Tab','\t'],['Esc','\x1b'],['↑','\x1b[A'],['↓','\x1b[B']].map(([name,value])=><button key={name} disabled={!canConnect||!connected} onClick={()=>sendKey(value)}>{name}</button>)}</div>
      <div className="terminal-statusbar"><span className={'terminal-state '+(canConnect&&connected?'connected':'disconnected')} role="status"><span className="connection-dot"/>{canConnect?status:'已断开 · 请先恢复或启动机器'}</span><button className="terminal-reconnect" aria-label="重新连接终端" disabled={!canConnect} onClick={()=>setAttempt(current=>current+1)}><RefreshCw size={13}/>{connected?'重连':'重新连接'}</button><span className="terminal-hint">Esc 传给终端 · 关闭保留远端会话</span></div>
    </footer>
    {!floating.maximized&&<div className="terminal-resize" aria-label="拖动调整终端大小" {...floating.resize}/>}
  </section>;
}
