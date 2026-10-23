import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

export async function checkTerminalConnections(browser, root, output) {
  const base='http://127.0.0.1:4178';
  const child=spawn(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'--mode','test','--host','127.0.0.1','--port','4178'],{cwd:root,env:{...process.env,VITE_DEMO:'false'},windowsHide:true,stdio:'ignore'});
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  try {
    let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(base)).ok;}catch{}if(ready)break;await new Promise(resolve=>setTimeout(resolve,150));}assert.ok(ready,'Terminal check server did not start');
    const page=await context.newPage(),errors=[],sockets=[];let closed=0;
    page.on('pageerror',error=>errors.push(error.message));
    await page.clock.install();
    const account={id:'test-account',label:'测试账号',enabled:true};
    const machine={id:'test-machine',name:'connection-check',state:'running',operationId:null,spec:{vcpus:2,memMiB:1024},runtime:{ready:true}};
    await page.route('**/api/**',async route=>{
      const url=new URL(route.request().url());
      const body=url.pathname==='/api/session'?{authenticated:true,username:'test-admin'}
        :url.pathname==='/api/accounts'?{accounts:[account]}
        :url.pathname==='/api/actions'?{actions:[]}
        :url.pathname==='/api/keepalive'?{intervalMinutes:1,maxMachines:5,policies:[],lastRunAt:null}
        :url.pathname.endsWith('/machines')?{machines:[machine],checkedAt:new Date(Date.now()+600000).toISOString()}:{};
      await route.fulfill({json:body});
    });
    await page.routeWebSocket('**/terminal?*',socket=>{
      sockets.push(socket);socket.onClose(()=>closed++);
      socket.send(JSON.stringify({type:'session',persistent:true}));
      socket.send(Buffer.from('connected session '+sockets.length+'\r\n'));
    });
    await page.goto(base+'/machines');
    const open=()=>page.getByRole('button',{name:'打开 connection-check 终端',exact:true}).click();
    const terminal=page.getByRole('dialog',{name:'connection-check',exact:true});
    const restore=()=>page.getByRole('button',{name:'恢复 connection-check 终端',exact:true}).click();
    const minimize=()=>terminal.getByRole('button',{name:'最小化终端窗口',exact:true}).click();
    const close=()=>terminal.getByRole('button',{name:'关闭终端',exact:true}).click();
    // Development StrictMode probes every new terminal with a mount/unmount cycle.
    // Measure connection changes after that cycle has settled.
    const readyTerminal=()=>terminal.getByText(/connected session \d+/).first().waitFor();
    await open();await readyTerminal();
    const initialConnections=sockets.length,initialClosed=closed;
    const original=await terminal.boundingBox();
    await minimize();await terminal.waitFor({state:'hidden'});
    sockets.at(-1).send(Buffer.from('output while minimized\r\n'));
    await page.clock.fastForward(61000);assert.equal(closed,initialClosed);assert.equal(sockets.length,initialConnections);
    await restore();await terminal.getByText('output while minimized',{exact:false}).first().waitFor();assert.deepEqual(await terminal.boundingBox(),original);
    await close();await page.clock.fastForward(59000);assert.equal(closed,initialClosed);
    await open();await terminal.waitFor();assert.equal(sockets.length,initialConnections);
    await page.clock.fastForward(61000);assert.equal(closed,initialClosed);
    await close();await page.screenshot({path:path.join(output,'terminal-dock-countdown.png')});
    await page.clock.fastForward(61000);await page.waitForFunction(()=>!document.querySelector('.floating-terminal'));assert.equal(closed,initialClosed+1);
    await open();await readyTerminal();const beforeImmediate=closed;
    await minimize();await page.getByRole('button',{name:'立即断开 connection-check 终端',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.floating-terminal'));assert.equal(closed,beforeImmediate+1);
    await open();await readyTerminal();const beforeLogout=closed;await minimize();
    await page.getByRole('link',{name:/操作记录/}).filter({visible:true}).click();assert.equal(closed,beforeLogout);
    await page.goBack();await page.getByRole('button',{name:'退出登录',exact:true}).filter({visible:true}).click();
    await page.getByRole('heading',{name:'登录私人控制台',exact:true}).waitFor();assert.equal(closed,beforeLogout+1);assert.deepEqual(errors,[]);
  } finally { await context.close();child.kill(); }
}
