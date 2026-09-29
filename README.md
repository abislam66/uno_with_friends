# 🎉 UNO Party

A colorful UNO game you play with friends in the browser: on laptops or phones, no sign-up and no installs for your friends.

## Start it

You need [Node.js](https://nodejs.org) 18 or newer. There are no packages to install.

```
cd "C:\lab work\uno-party"
npm start
```

The terminal prints two addresses:

- **On this computer:** `http://localhost:4000`
- **Friends on your Wi-Fi:** something like `http://192.168.1.23:4000`

The first time you run it, Windows may ask whether Node.js can use the network. Click **Allow** (private networks), or your friends won't be able to connect.

## Play with friends

1. Open the game, type your name, pick an avatar and click **Create a room**.
2. Click **Copy invite link** and send it to your friends. They can also open the Wi-Fi address and type the 4-letter room code.
3. Not enough people? Click **Add a computer player** (up to 8 players in total).
4. Choose the house rules and click **Start game**.

Testing alone? Open a second browser tab: each tab counts as a separate player.

### Closed the browser by accident?

Your seat is saved in your browser. Open the game again (or the invite link) and tap **↩ Rejoin game**. You get your same cards and score back, even in the middle of a round.

- While you're gone, your turns pass on their own (timer runs out, or the computer plays for you after 15 seconds if the timer is off).
- If you're gone for more than **1 minute**, a computer player stands in for you so your friends aren't kept waiting. Rejoining takes your seat back from it.
- If you close the tab while still in the lobby, you're removed after 30 seconds. Just join again.
- Don't want to go back? Tap **No thanks, leave that game** and the computer keeps your seat for good.
- If everyone leaves, the game pauses and waits up to 1 hour for someone to come back.

### Friends somewhere else (not on your Wi-Fi)

School and office Wi-Fi often blocks devices from talking to each other. If friends can't connect:

- Turn on your **phone's hotspot** and have everyone join it, or
- Share your game over the internet with a free tunnel while the server runs:
  `npx localtunnel --port 4000`. Send friends the `https://…` link it prints.

## How to play

- Match the top card by **color**, **number** or **symbol**. Wild cards go on anything.
- **Your turn is hard to miss:** a big "YOUR TURN!" pops up, your hand glows, a sound plays, phones buzz, and the browser tab flashes if you're on another tab.
- **No card to play?** The game draws one for you automatically. If the new card matches, you can play it or pass. Otherwise your turn is skipped.
- **Turn timer** (10/15/20/30 seconds, or off): a bar counts down on your screen and a ring counts down around the current player. If time runs out, you draw a card and your turn ends.
- **Stacking** (on by default): if someone plays +2 on you, play your own +2 and the next player takes **4**. A +4 can go on a +2 or a +4. If you can't stack, you take the whole pile of cards and lose your turn.
- **Skip** skips the next player. **Reverse** changes direction (with 2 players it works like Skip).
- Down to 2 cards? Press **UNO!** (or the `U` key) before you play. Forget, and everyone else gets 4 seconds to press **Catch!**. You then draw 2.
- First to empty their hand wins the round and scores the points left in everyone else's hand (numbers = face value, action cards = 20, wilds = 50).
- **First to the points goal wins the game.** The goal depends on how many are playing, so a game lasts about as long whatever the group size (the host can pick **No limit** instead):

  | Players | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | First to | 100 | 180 | 245 | 310 | 375 | 445 | 520 |
  | Average game | ~13 min | ~17 min | ~21 min | ~25 min | ~29 min | ~33 min | ~37 min |

  That's about 10–15 minutes for 2 players, plus about 4 minutes for each extra player. Single games vary a lot: a 2-player game can end in 3 minutes or run 25.
- Send emoji reactions with the 😀 button. Press `D` to draw.

## Files

| File | What it does |
| --- | --- |
| `uno.js` | The rules: deck, turns, stacking, UNO calls, scoring, computer players |
| `server.js` | Web server, rooms, live updates, turn timers, automatic draws, bots |
| `public/` | The game screens (`index.html`, `style.css`, `app.js`) |
| `test.js` | Rule checks + 500 simulated games (`npm test`) |
| `simulate.js` | Times thousands of full games to check game length (`npm run simulate`; try `-- --think 8` for slower players) |

The game-length numbers come from `npm run simulate`. It plays full games with computer players and times each turn the way the app runs: people take about 5 seconds to choose a card (a guess, not a measurement), the game draws for you after 1.4 seconds, and there are 12 seconds between rounds. If your group plays faster or slower, games will be shorter or longer.

Games live in the server's memory. Restarting the server ends all rooms (saved seats then just stop showing up).
