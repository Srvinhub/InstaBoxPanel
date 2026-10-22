import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Copy, Maximize2, Minus, Plus, RefreshCw, X, ClipboardPaste, TerminalSquare } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { isDemo } from './api';
import type { MachineRow } from './App';

export default function TerminalPane({ row, control, onClose }: { row: MachineRow; control: ReactNode; onClose: () => void }) {
  const dialog=useRef<HTMLDialogElement>(null), mount=useRef<HTMLDivElement>(null), term=useRef<Terminal|null>(null), socket=useRef<WebSocket|null>(null);
  const [status,setStatus]=useState('等待连接'),[error,setError]=useState(''),[attempt,setAttempt]=useState(0),[fontSize,setFontSize]=useState(13);
  const canConnect=row.machine.state==='running'&&row.account.enabled;
  useEffect(()=>{const el=dialog.current;el?.showModal();return()=>el?.close();},[]);
  useEffect(()=>{
    if(!canConnect||!mount.current)return;
    let disposed=false;
    setError('');setStatus(isDemo?'演示终端':'正在连接');
    const terminal=new Terminal({cursorBlink:true,fontSize:13,fontFamily:'Consolas, "Cascadia Code", "Courier New", monospace',scrollback:5000,screenReaderMode:true,allowProposedApi:false,
      theme:{background:'#17221f',foreground:'#d6e3d9',cursor:'#bdd8c0',selectionBackground:'#59756380',black:'#22332a',red:'#e68a78',green:'#a6d493',yellow:'#dbc38a',blue:'#91b4cd',magenta:'#c7a6cf',cyan:'#91c9bc',white:'#dbe5d9',brightBlack:'#7a9284',brightRed:'#efac9d',brightGreen:'#c1e8aa',brightYellow:'#f0d59f',brightBlue:'#b2d2e8',brightMagenta:'#dec4e1',brightCyan:'#b6e1d5',brightWhite:'#f0f5ef'}});
    const fit=new FitAddon();terminal.loadAddon(fit);terminal.open(mount.current);term.current=terminal;
    // Ignore remote clipboard escape sequences. Copy/paste is a local user action.
    terminal.parser.registerOscHandler(52,()=>true);
    const resize=()=>{if(disposed)return;fit.fit();if(socket.current?.readyState===WebSocket.OPEN)socket.current.send(JSON.stringify({type:'resize',cols:Math.max(10,Math.min(1000,terminal.cols)),rows:Math.max(4,Math.min(500,terminal.rows))}));};
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
      ws.onopen=()=>{if(disposed)return;setStatus('已连接');terminal.options.disableStdin=false;resize();terminal.focus();};
      ws.onmessage=event=>{
        if(disposed)return;
        if(typeof event.data!=='string'){terminal.write(new Uint8Array(event.data as ArrayBuffer));return;}
        try{
          const data=JSON.parse(event.data);
          if(data.type==='session')setStatus(data.persistent?'已连接 · 持久会话':'已连接 · 临时会话');
          else if(data.type==='exit'){setStatus('Shell 已退出（'+data.code+'）');terminal.options.disableStdin=true;}
          else if(data.type==='taken'){setStatus('会话已在其他页面打开');terminal.options.disableStdin=true;}
          else if(data.type==='error'){setError('远端终端报告错误，请检查机器状态后重新连接。');terminal.options.disableStdin=true;}
        }catch{setError('收到了无法识别的终端消息。');}
      };
      const send=(bytes:Uint8Array)=>{
        if(ws.readyState!==WebSocket.OPEN)return;
        if(ws.bufferedAmount>512*1024){setError('网络积压过多，已断开；未发送的输入不会重放。');ws.close(1000,'input backlog');return;}
        ws.send(bytes);
      };
      dataSubscription=terminal.onData(data=>send(encoder.encode(data)));
      binarySubscription=terminal.onBinary(data=>send(Uint8Array.from(data,c=>c.charCodeAt(0))));
      ws.onerror=()=>{if(!disposed)setError('连接失败。请确认登录有效、机器正在运行，且 Key 具备 machines:write 权限。');};
      ws.onclose=()=>{if(!disposed){setStatus(s=>s.startsWith('Shell')||s.includes('其他页面')?s:'连接已断开');terminal.options.disableStdin=true;}};
    }
    terminal.attachCustomKeyEventHandler(event=>{
      if(event.type==='keydown'&&(event.ctrlKey||event.metaKey)&&event.shiftKey&&event.code==='KeyC'){event.preventDefault();void navigator.clipboard.writeText(terminal.getSelection()).catch(()=>setError('无法复制，请检查浏览器剪贴板权限。'));return false;}
      if(event.type==='keydown'&&(event.ctrlKey||event.metaKey)&&event.shiftKey&&event.code==='KeyV'){event.preventDefault();void navigator.clipboard.readText().then(text=>terminal.paste(text)).catch(()=>setError('无法读取剪贴板，可使用系统粘贴快捷键。'));return false;}
      return true;
    });
    return()=>{disposed=true;observer.disconnect();window.removeEventListener('resize',onFocus);dataSubscription?.dispose();binarySubscription?.dispose();socket.current?.close(1000,'panel closed');socket.current=null;terminal.dispose();term.current=null;};
  },[canConnect,row.account.id,row.machine.id,attempt]);
  useEffect(()=>{if(term.current)term.current.options.fontSize=fontSize;window.dispatchEvent(new Event('resize'));},[fontSize,attempt]);
  const sendKey=(value:string)=>{if(isDemo){term.current?.input(value,true);}else if(socket.current?.readyState===WebSocket.OPEN){socket.current.send(new TextEncoder().encode(value));}term.current?.focus();};
  const clipboard=async(paste:boolean)=>{try{if(paste)term.current?.paste(await navigator.clipboard.readText());else await navigator.clipboard.writeText(term.current?.getSelection()||'');term.current?.focus();}catch{setError('无法访问剪贴板，请使用浏览器允许的复制粘贴方式。');}};
  return <dialog ref={dialog} className="terminal-dialog" aria-labelledby="terminal-title" onCancel={e=>e.preventDefault()}>
    <header className="terminal-heading"><div><TerminalSquare size={19}/><h2 id="terminal-title">{row.machine.name}</h2><span>{isDemo?'演示':row.account.label}</span></div><button className="terminal-icon" aria-label="关闭终端" onClick={onClose}><X size={20}/></button></header>
    <div className="terminal-toolbar"><span className="terminal-state"><span className="connection-dot good"/>{canConnect?status:'请先恢复或启动机器'}</span><div>
      <button className="terminal-icon" aria-label="复制选中内容" onClick={()=>void clipboard(false)}><Copy size={15}/></button><button className="terminal-icon" aria-label="粘贴到终端" onClick={()=>void clipboard(true)}><ClipboardPaste size={15}/></button>
      <button className="terminal-icon" aria-label="缩小终端字体" onClick={()=>setFontSize(s=>Math.max(11,s-1))}><Minus size={15}/></button><button className="terminal-icon" aria-label="放大终端字体" onClick={()=>setFontSize(s=>Math.min(20,s+1))}><Plus size={15}/></button>
      <button className="terminal-icon" aria-label="重新连接终端" disabled={!canConnect} onClick={()=>setAttempt(a=>a+1)}><RefreshCw size={15}/></button><button className="terminal-icon" aria-label="切换终端全屏" onClick={()=>void(document.fullscreenElement?document.exitFullscreen():dialog.current?.requestFullscreen())?.catch(()=>setError('浏览器未允许全屏。'))}><Maximize2 size={15}/></button>
    </div></div>
    {error&&<div className="terminal-error" role="alert">{error}</div>}
    {canConnect?<div className="terminal-mount" ref={mount}/>:<div className="terminal-wait"><TerminalSquare size={34}/><p>机器运行后，可以连接它的交互终端。</p>{control}</div>}
    <footer className="terminal-footer"><div className="terminal-keys">{[['Ctrl+C','\x03'],['Ctrl+D','\x04'],['Ctrl+L','\x0c'],['Ctrl+R','\x12'],['Ctrl+W','\x17'],['Tab','\t'],['Esc','\x1b'],['↑','\x1b[A'],['↓','\x1b[B']].map(([name,value])=><button key={name} disabled={!canConnect} onClick={()=>sendKey(value)}>{name}</button>)}</div><span>Esc 传给终端 · 关闭窗口只断开连接 · 未发送的输入不会重放</span></footer>
  </dialog>;
}
