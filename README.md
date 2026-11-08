# Brclio-couch-tycoon · 客厅大富翁网页版

2–6 人一起掷骰环游世界、买地盖房、收租，争夺首富。桌面、平板和手机都能直接参与，每位玩家自己的页面同时显示棋盘、钱包和操作区。

[开始游戏](https://party-tycoon.aiyuechuang.workers.dev/) · [完整规则](规则.md) · [运行与存储](技术方案.md)

## 三种玩法

| 入口 | 怎么玩 |
|---|---|
| `/` 或 `/party` | 创建好友房间，把链接或 4 位房间码发给朋友。房主也选角色并准备，至少两人全部准备后开局。 |
| `/p/房间码` | 每人选一个角色，可以掷骰、买地、盖房、抵押、还贷、确认扣款或抽卡、挂牌及跨回合抢购。房主可以暂停、继续、马上排名或发起重赛。 |
| `/local` | 一台设备上 2–6 人轮流操作。即时保存到浏览器，联网时备份到云端。「云存档」提供专属恢复链接。持链接者可以继续这局，请自行保管。 |
| `/online` 或 `/t/邀请码` | 用账号创建或加入桌子，可设置锁桌与人数，通过 6 位邀请码进桌。时长支持 30 分钟、60 分钟和不限时。 |

同一好友房间里最多 6 人，从 18 个角色中各选一个。浏览器会保存座位身份；更换设备时，可向房主索取专属的一次性恢复链接。已掉线房主长期不回来，仍在线的玩家可以接手房主职责。手机的震动和摇动掷骰取决于浏览器和设备权限，点按掷骰在所有布局中可用。

## 游戏规则

- 一圈 68 格，有 48 个国家、4 个机场及 2 家公用事业公司。起始资金为 $2,500，小狗角色额外获得 $500，经过起点领 $400。
- 停在无主的国家可直接买地并盖 0、1 或 2 栋；每次停留最多盖 2 栋，4 栋以后可升级酒店。整组空地租金翻倍。机场按持有数收租，公司按骰点收租。
- 可以按自己的价格挂牌卖地，其他玩家谁先成交谁买到，地产上的房屋和抵押状态随交易转移。欠债时可卖房、抵押或出售地产。还不上会触发破产清算。
- 机会与命运共用 12 张卡。双骰同点可再掷一次，连续三次同点直接进监狱；罚金、出狱卡或掷双数均可出狱。
- 剩一人时立即结束。限时局在当前轮走完后按净资产排名。好友房支持回合超时托管、简单回合自动结束以及「等一下」。

## 本地运行和验证

需要 Node.js 22.12+ 和 npm。以下命令用本机的 Cloudflare Workers 运行时和独立测试数据。

```sh
npm ci
npm start
```

打开 <http://localhost:5200>。本地默认使用持久化的 Durable Objects 模拟存储；本地运行不会写生产数据仓库。

```sh
npm test
node test/cloud-room.mjs http://127.0.0.1:5200
node test/cloud-lobby.mjs http://127.0.0.1:5200
node test/cloud-save.mjs http://127.0.0.1:5200
node test/cloud-recovery.mjs
node --test test/cloud-room-state.mjs
node test/web.mjs http://127.0.0.1:5200
```

浏览器回归使用已安装的 Chrome。测试脚本会创建独立浏览器上下文，测试注册账号和房间应优先在本地运行。历史 Node 服务仍保留在 `server.js`，原有协议回归见 `test/party.mjs`、`test/e2e.mjs`。

## Cloudflare 与 GitHub

公开源码为 [Brclio/Brclio-couch-tycoon](https://github.com/Brclio/Brclio-couch-tycoon)，私有数据为 [BrclioData/brclio-couch-tycoon-data](https://github.com/BrclioData/brclio-couch-tycoon-data)。部署配置使用静态资源、Worker 和 SQLite 后端的 Durable Objects，适配 Workers Free。生产构建命令是 `npm run assets`，部署命令是 `npx wrangler deploy`。

Cloudflare 的 Secret `GITHUB_APP_PRIVATE_KEY` 使用 PKCS#8 PEM。App 必须安装到数据仓库，并拥有 Contents 读写权限。Worker 签发仅限该仓库的短期令牌。游戏动作先写入 Durable Objects，随后合并提交到 GitHub；写入失败会保留待同步状态并重试。对局结算另外保留完整终局。文件路径与恢复说明见[技术方案](技术方案.md)。

音效由浏览器合成，中文语音可使用系统朗读。原有 Gemini 配音可通过 Worker Secret `GEMINI_API_KEY` 启用，属于可选外部服务。

## 素材与来源

项目保留原作客厅大富翁的规则和素材。原作作者为洛克船长。角色来自 [Microsoft Fluent Emoji](https://github.com/microsoft/fluentui-emoji)，国旗来自 [flag-icons](https://github.com/lipis/flag-icons)，二维码库来自 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)。原型截图在 `docs/`，早期六轮设计记录在 `passes/`。网页版界面参考 Brclio Design System。
