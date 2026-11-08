// 同屏对局和远程房间共用棋盘、地契、银行流水和动画图层。
document.getElementById('gameRoot').innerHTML = `
<header class="bar" id="bar">
    <a class="logo" href="/" aria-label="客厅大富翁首页"><span class="globe"></span><span>客厅大富翁</span></a>
    <div class="clock" id="clock"></div>
    <nav class="ptabs" id="tabs"></nav>
    <div class="toggles" id="toggles"></div>
    ${document.body.classList.contains('room-page') ? '<a class="room-jump" href="#boardArea">棋盘</a><a class="room-jump" href="#app">我的回合</a>' : ''}
    <button class="ghost" id="newGame" title="新游戏">新游戏</button>
  </header>

  <main class="stage">
    <section class="board-area" id="boardArea">
      <div class="board" id="board">
        <div class="center" id="center">
          <div class="center-deco">
            <div class="pile pile-chance"><span>?</span>机会</div>
            <div class="pile pile-fate"><span>!</span>命运</div>
          </div>
          <div class="center-main">
            <div class="turn-info" id="turnInfo"></div>
            <div class="dice" id="dice">
              <div class="die3d"><div class="cube" id="die0"></div></div>
              <div class="die3d"><div class="cube" id="die1"></div></div>
            </div>
            <div class="actions" id="actions"></div>
          </div>
        </div>
        <div class="tokens" id="tokens"></div>
      </div>
    </section>

    <aside class="side">
      <div class="room-ui" id="app"></div>
      <section class="panel bank" id="bank"></section>
      <section class="panel deed" id="deed"></section>
      <details class="panel log" id="logBox">
        <summary>对局记录</summary>
        <ol id="log"></ol>
      </details>
    </aside>
  </main>

  <div class="overlay" id="overlay"></div>
  <div class="prompt" id="prompt"></div>
  <div class="cardlayer" id="cardLayer"></div>
  <div class="banner" id="banner"></div>
  <div class="toast" id="toast"></div>
  <div class="fx" id="fx"></div>
`;
