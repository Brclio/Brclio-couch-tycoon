// 棋盘与卡牌，数字全部来自 规则.md，前后端共用。

export const START_CASH = 2500;
// 选了这些角色的玩家开局多拿钱（银行发，记进银行流水）。1f436 = 小狗
export const AVATAR_BONUS = { '1f436': 500 };
// 可选的角色（图标来自 Microsoft Fluent Emoji 3D，public/avatars/）
export const CHARS = [
  { code: '1f43c', name: '熊猫' }, { code: '1f436', name: '小狗' }, { code: '1f431', name: '小猫' },
  { code: '1f98a', name: '狐狸' }, { code: '1f42f', name: '老虎' }, { code: '1f427', name: '企鹅' },
  { code: '1f984', name: '独角兽' }, { code: '1f438', name: '青蛙' }, { code: '1f996', name: '恐龙' },
  { code: '1f43b', name: '大熊' }, { code: '1f435', name: '猴子' }, { code: '1f916', name: '机器人' },
  { code: '1f47d', name: '外星人' }, { code: '1f680', name: '火箭' }, { code: '1f3ce', name: '赛车' },
  { code: '2708', name: '飞机' }, { code: '1f3a9', name: '礼帽' }, { code: '1f451', name: '皇冠' },
];
export const GO_SALARY = 400;
export const JAIL_FINE = 50;
export const TURN_SECONDS = 30;
export const BUILD_PER_STOP = 2;   // 每次停在自己的国家上，最多盖几栋（升酒店也算一栋）

// 48 个国家，12 组 × 4 个，按价格从便宜到贵
export const GROUPS = {
  sasia:  { name: '南亚',       color: '#8b5a3c', house: 50 },
  africa: { name: '非洲',       color: '#5fb3d9', house: 50 },
  sea:    { name: '东南亚',     color: '#d6589a', house: 50 },
  mideast:{ name: '中东',       color: '#f08c2e', house: 100 },
  latam:  { name: '拉美',       color: '#14b8a6', house: 100 },
  ocean:  { name: '北美大洋洲', color: '#e0463c', house: 100 },
  eeu:    { name: '中东欧',     color: '#e8c22c', house: 150 },
  seu:    { name: '南欧',       color: '#84cc16', house: 150 },
  nordic: { name: '北欧',       color: '#3ea35a', house: 150 },
  weu:    { name: '西欧',       color: '#8e4fc9', house: 200 },
  east:   { name: '东亚',       color: '#2f55b5', house: 200 },
  top:    { name: '顶级',       color: '#1e293b', house: 200 },
};

const COUNTRIES = [
  ['尼泊尔', 'np'], ['孟加拉', 'bd'], ['斯里兰卡', 'lk'], ['印度', 'in'],
  ['肯尼亚', 'ke'], ['尼日利亚', 'ng'], ['摩洛哥', 'ma'], ['南非', 'za'],
  ['柬埔寨', 'kh'], ['越南', 'vn'], ['菲律宾', 'ph'], ['泰国', 'th'],
  ['埃及', 'eg'], ['约旦', 'jo'], ['土耳其', 'tr'], ['沙特', 'sa'],
  ['秘鲁', 'pe'], ['智利', 'cl'], ['阿根廷', 'ar'], ['巴西', 'br'],
  ['墨西哥', 'mx'], ['新西兰', 'nz'], ['加拿大', 'ca'], ['澳大利亚', 'au'],
  ['波兰', 'pl'], ['捷克', 'cz'], ['希腊', 'gr'], ['葡萄牙', 'pt'],
  ['西班牙', 'es'], ['意大利', 'it'], ['奥地利', 'at'], ['法国', 'fr'],
  ['丹麦', 'dk'], ['芬兰', 'fi'], ['瑞典', 'se'], ['挪威', 'no'],
  ['比利时', 'be'], ['荷兰', 'nl'], ['瑞士', 'ch'], ['德国', 'de'],
  ['新加坡', 'sg'], ['韩国', 'kr'], ['日本', 'jp'], ['中国', 'cn'],
  ['卡塔尔', 'qa'], ['阿联酋', 'ae'], ['英国', 'gb'], ['美国', 'us'],
];
const GROUP_KEYS = Object.keys(GROUPS);
// 第 g 组：前两个 60+40g，后两个再贵 20；美国单独定价
const countryPrice = (k) => k === 47 ? 550 : 60 + Math.floor(k / 4) * 40 + (k % 4 >= 2 ? 20 : 0);

const SPECIAL = {
  F: () => ({ type: 'fate', name: '命运' }),
  H: () => ({ type: 'chance', name: '机会' }),
  T1: () => ({ type: 'tax', name: '所得税', amount: 200 }),
  T2: () => ({ type: 'tax', name: '奢侈税', amount: 100 }),
  A1: () => ({ type: 'airport', name: '东京机场', price: 200 }),
  A2: () => ({ type: 'airport', name: '迪拜机场', price: 200 }),
  A3: () => ({ type: 'airport', name: '伦敦机场', price: 200 }),
  A4: () => ({ type: 'airport', name: '纽约机场', price: 200 }),
  U1: () => ({ type: 'utility', name: '电力公司', price: 150, util: 'electric' }),
  U2: () => ({ type: 'utility', name: '自来水公司', price: 150, util: 'water' }),
};

// 长方形棋盘：长边每边 19 格、短边每边 13 格，加 4 个角，一共 68 格。C = 下一个国家
export const LONG_SIDE = 19;
export const SHORT_SIDE = 13;
const LAYOUT = [
  'GO',
  'C F C C T1 C C C A1 C C H C C C C C C C',
  'JAIL',
  'C U1 C C F C A2 C C H C C C',
  'PARKING',
  'C H C C C C U2 C C A3 C C C F C C C C C',
  'GOTOJAIL',
  'C F C C A4 C H C C C T2 C C',
];

export const SQUARES = [];
{
  let k = 0;
  const corner = { GO: { type: 'go', name: '起点' }, JAIL: { type: 'jail', name: '监狱' }, PARKING: { type: 'parking', name: '免费停车' }, GOTOJAIL: { type: 'gotojail', name: '入狱' } };
  for (const row of LAYOUT) {
    for (const t of row.split(' ')) {
      if (corner[t]) SQUARES.push({ ...corner[t] });
      else if (t === 'C') {
        const [name, flag] = COUNTRIES[k];
        SQUARES.push({ type: 'country', name, price: countryPrice(k), group: GROUP_KEYS[Math.floor(k / 4)], flag });
        k++;
      } else SQUARES.push(SPECIAL[t]());
    }
  }
}
export const BOARD_SIZE = SQUARES.length;   // 68
export const JAIL_POS = SQUARES.findIndex(s => s.type === 'jail');
export const AIRPORTS = SQUARES.filter(s => s.type === 'airport').map(s => s.index ?? SQUARES.indexOf(s));

SQUARES.forEach((s, i) => { s.index = i; });

export const OWNABLE = SQUARES.filter(s => s.price).map(s => s.index);

export function groupMembers(group) {
  return SQUARES.filter(s => s.group === group).map(s => s.index);
}

export const baseRent = (sq) => Math.round(sq.price / 10);
// 0 栋 = 空地，1–4 栋房，5 = 酒店
export const HOUSE_MULT = [1, 4, 12, 28, 34, 40];   // 2026-10-31 改为经典版曲线
export const AIRPORT_RENT = [0, 25, 50, 100, 200];
export const UTILITY_MULT = [0, 4, 10];

export const mortgageValue = (sq) => Math.floor(sq.price / 2);
export const unmortgageCost = (sq) => Math.ceil(mortgageValue(sq) * 11 / 10);

// mood：good 好消息 / bad 坏消息 / neutral 一般，界面据此显示笑脸或哭脸
export const CARDS = [
  { id: 1,  text: '前进到起点，领 $400',                      kind: 'goto', mood: 'good', to: 0 },
  { id: 2,  text: '前进到美国',                               kind: 'goto', mood: 'neutral', to: SQUARES.findIndex(s => s.flag === 'us') },
  { id: 3,  text: '前进到最近的机场，若有主人付双倍过路费',   kind: 'airport', mood: 'neutral' },
  { id: 4,  text: '后退 3 格',                                kind: 'back', mood: 'neutral', n: 3 },
  { id: 5,  text: '直接进监狱',                               kind: 'jail', mood: 'bad' },
  { id: 6,  text: '出狱卡（可保留）',                         kind: 'jailcard', mood: 'good' },
  { id: 7,  text: '银行分红，领 $50',                         kind: 'money', mood: 'good', amount: 50 },
  { id: 8,  text: '理财到期，领 $150',                        kind: 'money', mood: 'good', amount: 150 },
  { id: 9,  text: '生日，每位玩家给你 $10',                   kind: 'collectEach', mood: 'good', amount: 10 },
  { id: 10, text: '罚款 $15',                                 kind: 'money', mood: 'bad', amount: -15 },
  { id: 11, text: '房屋维修：每栋房 $25，每座酒店 $100',      kind: 'repairs', mood: 'bad', house: 25, hotel: 100 },
  { id: 12, text: '当选主席，付给每位玩家 $50',               kind: 'payEach', mood: 'bad', amount: 50 },
];

export const PLAYER_COLORS = ['#e0463c', '#2f55b5', '#3ea35a', '#e8a21c', '#8e4fc9', '#1aa3a3'];
