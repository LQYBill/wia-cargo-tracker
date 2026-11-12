import {scryptSync,randomBytes} from 'node:crypto';
import readline from 'node:readline';
if(!process.stdin.isTTY)throw Error('请在交互式终端运行，避免密码出现在命令历史中');
process.stdout.write('输入管理员密码（至少12位，不回显）：');
process.stdin.setRawMode(true);process.stdin.resume();readline.emitKeypressEvents(process.stdin);let password='';
process.stdin.on('keypress',(str,key)=>{
 if(key?.ctrl&&key?.name==='c'){process.stdin.setRawMode(false);process.exit(1);}
 if(key?.name==='return'){process.stdin.setRawMode(false);process.stdin.pause();if(password.length<12){console.error('\n密码至少12位');process.exit(1);}const salt=randomBytes(16).toString('hex');console.log('\nADMIN_PASSWORD_HASH='+salt+':'+scryptSync(password,salt,64).toString('hex'));process.exit(0);}
 else if(key?.name==='backspace')password=password.slice(0,-1);else if(str&&!key?.ctrl)password+=str;
});
