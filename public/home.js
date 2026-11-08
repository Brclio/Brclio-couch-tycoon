import { SQUARES, GROUPS } from '/shared/board.js';
import { boardPosition } from './board-position.js';

const $ = id => document.getElementById(id);
const valid = code => /^[A-HJ-NP-Z2-9]{4}$/.test(code);
for (const tile of SQUARES) {
  const el = document.createElement('i');
  el.style.gridArea = boardPosition(tile.index).join(' / ');
  if (tile.group) el.style.setProperty('--group', GROUPS[tile.group].color);
  if (tile.flag) {
    const image = document.createElement('img');
    image.src = '/flags/' + tile.flag + '.svg';
    image.alt = '';
    el.append(image);
  } else el.textContent = ({go:'➜', chance:'?', fate:'!', airport:'✈', utility:'ϟ', tax:'$', jail:'▦', parking:'P', gotojail:'▦'})[tile.type];
  $('miniBoard').append(el);
}
try {
  const last = localStorage.getItem('mf_last_room') || '';
  if (valid(last) && localStorage.getItem('mf_phone_' + last)) {
    $('resume').href = '/p/' + last;
    $('resume').textContent = '返回房间 ' + last + ' →';
    $('resume').hidden = false;
  }
} catch {}
$('create').onclick = async () => {
  $('create').disabled = true;
  $('message').textContent = '正在创建房间…';
  try {
    try { localStorage.setItem('mf_storage_check', '1'); localStorage.removeItem('mf_storage_check'); }
    catch { throw new Error('请允许此网站保存房间身份后再创建房间。'); }
    const response = await fetch('/api/rooms', {method:'POST'});
    const room = await response.json();
    if (!response.ok || !valid(room.code) || !room.token) throw new Error(room.error || '创建失败，请重试');
    try { localStorage.setItem('mf_phone_' + room.code, room.token); }
    catch { throw new Error('请允许此网站保存房间身份后再创建房间。'); }
    location.assign('/p/' + room.code);
  } catch (error) {
    $('message').textContent = error.message || '网络连接失败，请重试';
    $('create').disabled = false;
  }
};
$('join').onsubmit = e => {
  e.preventDefault();
  const code = $('code').value.trim().toUpperCase();
  if (!valid(code)) { $('message').textContent = '请输入房主分享的 4 位房间码'; $('code').focus(); return; }
  location.assign('/p/' + code);
};
