v2 changes (2026-08-19, after the morning meeting): I-4 and I-5 comments, PARKED status, I-16 added.
v3 changes (2026-08-19, after the events push landed): receipts from a client-side delta recon of chaincraft-runtime 159275b and game-server 14ab5e0. I-4 wire receipts, I-8 RESOLVED, I-13 and I-15 notes.
v4 changes (2026-08-20, before the producer push, at Eric's request): I-3 updated with the 159275b build result, I-4 gains the client consumer status and the sync-after-action gap, I-9 gains sequence receipts, I-15 gains two wire notes, and four new issues I-17 through I-20 from live browser integration: the doubled game-start prompt, the ready-restarts-a-match guard, the broadcast double, and CORS. Context: integration's client half is complete, live High Card matches verified end to end in real browsers, and every client mechanism that can stand down automatically when the producers land already does.

## I-1. No compiled game can declare a winner — STATUS: OPEN (sharpest)
winConditions are skipped by the compiler (assembler/flow.ts:269-270, "deferred to Phase 6"), so the runtime exhausts the flow and completes with {"reason":"flow-exhausted"} and NO winnerIds. Observed: alice won High Card 2-1 on the spec's own ranking; the terminal frame named no winner and the spec's onVictory message never fired. Client consequence: we cannot show a victory screen without doing rules reasoning client-side, which we are forbidden to do by design.
> comments:
> hub 2026-08-20: still true at 14ab5e0 across many full live matches; every ending arrives as flow-exhausted with no winnerIds, and our banner deliberately never says the word winner until the wire does. Noting for the record that high-card.yaml itself declares a winConditions ranking on player score with an onVictory message, so the spec asks for a winner the engine cannot yet name.

## I-2. Gamepiece property visibility is a compiler no-op — STATUS: OPEN
The property config copies mutable + type and never copies p.visibility (assembler/config.ts:66-72), so projection falls back to 'always' for every gamepiece property. Observed leak: a face-down card on the shared table ships {"value":5} to the opponent. Projection itself is correct; it is handed an empty rulebook. Harmless in High Card, not in general.
> comments:

## I-3. Both main branches fail typecheck; dist ships anyway — STATUS: OPEN
runtime build exits 1 with 32 errors (GameSession.events used at 19 call sites but absent from the type; EffectContext.sourcePieceId/targetPieceId), compiler exits 1 with 6 (including the top-revealed union clash). Complete dist emits only because noEmitOnError is unset — which is why the server runs. A CI gate on either repo would be red today. Is this known/accepted drift?
> comments:
> hub 2026-08-20: big improvement at 159275b. The runtime build now exits 1 with only 6 errors, down from 32, all one shape: sourcePieceId and targetPieceId missing on EffectContext, in resolve-value.ts (4), set-state.ts (1) and update.ts (1). dist still emits in full, 186 files, and the server runs on exactly those bytes. The compiler's 6 are unchanged since it had no push. The question stands only for the remaining dozen.
> eaw 2026-08-20: Fixed.  Please verify and resolve.

## I-4. State updates: batched events — STATUS: ANSWERED (Eric 2026-08-19)
Clients get batched, sequenced EVENTS per state change, not full state and not diffs, chosen explicitly so clients can animate intuitively and never build diffs. api-types update landing imminently with the event shapes; NOT projected initially, projection to follow. Client note: until projection lands, events may carry information the receiving player shouldn't see; treat as dev-trusted interim.
> comments:
> hub 2026-08-19, from the morning meeting: events and their projection layer are the two remaining integration steps before Eric returns to the compiler roadmap; the push is expected tonight or by the weekend. Design detail as spoken: a move event names the source and destination inventory; a draw from a hidden source projects to observers as a count only, with no identifier at all, so pieces cannot be tracked between hidden zones; shuffle is a bare event carrying no data, purely an animation hook; once a piece is revealed, its identity and its revealed-plus-always properties become visible, and on a face-down discard the identifying information is gone again. Client stance unchanged until the push proves otherwise: treat any unprojected interim as dev-trusted.
> hub 2026-08-19, after the push (runtime 159275b, game-server 14ab5e0): the shapes landed. StateChangeEvent is an eleven-member union in game-server/src/api-types.ts (piece:moved, pieces:distributed, piece:flipped, piece:rolled, piece:oriented, piece:exhausted, piece:property-changed, piece:revealed, piece:hidden, inventory:shuffled, state:property-changed), delivered as {type:"state-change", seq, data: StateChangeEvent[]}. The pipeline is wired end to end (runtime event bus, GameController buffer and flush, SessionManager broadcast) but no effect emits state:change yet, so the channel is silent in every real game today. Two things for you: (1) pushStateChanges at game-server/src/session-manager.ts:327-338 sends one identical unprojected payload to every socket, while chaincraft-runtime/src/api/state-change-events.ts:1-4 says events are "Projected per-viewer by the server before sending over the wire". Moot while nothing emits, a hidden-hand leak the moment something does. (2) Are the producers and the per-viewer projection step the weekend round, and should our client build against projected or unprojected delivery?
> hub 2026-08-20: our side of the pipe is finished and dormant. The client now carries a full events consumer handling all eleven kinds, applying each batch atomically in seq order, with leak safety (an event referencing a piece absent from this seat's projection aborts the whole batch and recovers by reconnect) and an automatic switchover: the first state-change frame a session ever receives permanently stands down our interim polling for that session, and a resync arriving while events flow is authoritative and resets the baseline. Confirmed dormant against 14ab5e0: full matches log zero state-change frames. THE SYNC-AFTER-ACTION GAP this papers over, stated plainly: syncAllPlayers runs exactly once, when the last player readies, and after that the only state channel is the one nothing feeds, so a client is blind to every mid-match change. Our interim is a resync via reconnect after each answer, which works and is ugly, one socket cycle per answer per seat, and it is what every client would be forced to build today. It retires itself the moment your producers emit. When they do, cards animate on our table with zero further client work.

## I-5. GET /sessions/:id/state — STATUS: ANSWERED (removal)
The unauthenticated, unprojected state route goes away entirely. TEE direction: in-progress game state will be invisible to everyone until completion. Clients must never depend on this route.
> comments:
> hub 2026-08-19: the morning meeting reaffirmed this in stronger terms. The production direction is a hardware-isolated trusted execution environment: no interface returns in-progress data to anyone, and results move out to the database only when the game completes.

## I-6. Prompt concurrency — STATUS: RESOLVED (design)
Any given client has AT MOST ONE active prompt, permanently. Simultaneous turn order (when it arrives) means multiple clients each holding one, never one client holding two. Client contract locked accordingly.
> comments:

## I-7. top-revealed visibility value — STATUS: ANSWERED (deferred)
Optimistic capture in gamedef c7cb72a so the need isn't lost; runtime/compiler implementation later. It is currently the first compiler typecheck error. No spec should use it yet.
> comments:

## I-8. SessionManager.playerCount is a manager-level singleton — STATUS: RESOLVED (fixed in game-server 14ab5e0)
Was: overwritten by every createSession (:77,:85); two concurrent sessions of different games shared whichever count came last.
> comments:
> hub 2026-08-19: fixed as part of the events commit. playerCount moved off the manager and onto HostedSession itself, set per session in createSession from module.metadata.playerCount, and the join and ready call sites now read session.playerCount. Confirming here with the receipt so the fix does not get lost, since the commit message only mentions the events work.

## I-9. messageQueue never appended — STATUS: ACKNOWLEDGED
Read and cleared on connect, never written; messages emitted while a player is disconnected are lost (observed: bob missed "alice takes the trick!" during the disconnect probe). Prompts self-heal via sync redelivery; messages do not.
> comments:
> hub 2026-08-19: unchanged by 14ab5e0; the field and its initialization are untouched and pushToRecipients still delivers to live sockets only.
> hub 2026-08-20: the new sequence numbers now make the loss detectable, though not recoverable. Captured: a seat's own message seqs ran 1, 2, 4, and the reconnect sync carried messageSeq 3 against the 2 it had seen, with messages[] empty. So a client can know it missed something and cannot learn what. Our client raises one plain line and resyncs state; the content stays gone.

## I-10. timeoutMs declared, unimplemented — STATUS: OPEN
Exists on the suspension type with a comment promising spec-defined defaults on expiry; nothing sets, reads, or enforces it; no default field exists. Observed: the engine waited indefinitely for a disconnected player. When it lands, every client prompt needs a countdown + default-applied path — where would the default be declared in a spec?
> comments:
> eaw 2026-08-20: Probably in the turn order on the spec.  Leave this open to remind me to add it.

## I-11. Turn order is join order — STATUS: OPEN
init receives Array.from(players.keys()); whoever joins first is P1. Is explicit seat assignment planned, or should clients control join order to control seats?
> comments:
> eaw 2026-08-20:  Turn order supports choosing the starting player via state values, piece possesion (e.g. first player marker), rotating starting order, etc...  Not implemented yet, but in the spec.

## I-12. gamepiece-select with fromPlayer:{param:...} returns no options — STATUS: OPEN
The resolver can't see the group's collected inputs (options.ts:69), so "steal from the player you picked" sends no eligible list. Will actor/collected context be threaded through?
> comments:

## I-13. inventory-position inputs have no option list — STATUS: OPEN
Resolved value is an InventoryPlacement descriptor; no candidate list is computed. How should a client present legal positions, especially for grid/graph inventories?
> comments:
> hub 2026-08-19: the value shape is now concrete. api-types defines InventoryPosition (stack-top, stack-bottom, stack-index, line-index, grid-cell, graph-node) and the runtime renamed InventoryPlacement to InventoryPosition throughout, adding the stack-index variant. The question of a computed option list stands.

## I-14. Session lifecycle & persistence — STATUS: OPEN (low)
Nothing tears down a session, expires a token, or persists across a server restart (in-memory Map). Intended host-era work?
> comments:

## I-15. Client-side wire notes for both teams — STATUS: RESOLVED (recorded)
(a) Pre-game sync omits absent keys entirely (JSON.stringify drops undefined): test "gameState" in data. (b) A reconnecting player's owed prompt arrives INSIDE sync.data.prompt with no separate prompt frame — clients need both intake paths. (c) Game start fires message and prompt BEFORE the first game sync (init settles synchronously before syncAllPlayers), so a prompt can name pieces the client has no state for yet; clients must tolerate prompt-before-state. (d) A single-option input still prompts (options:["card1"]); auto-execute applies to action selection only. (e) REST errors return {error:<enum>}, WS errors return {code,message} — two shapes. (f) DEP0166 double-slash import warnings at startup (dist/inventory/factory.js), cosmetic today. (g) Session ids don't carry the game id despite the helper's comment (cosmetic).
> comments:
> hub 2026-08-19: additions from 14ab5e0. SyncServerMessage joined the ServerMessage union for the first time, and sequence numbers arrived: sync carries stateChangeSeq and messageSeq, message frames carry seq, state-change frames carry seq, so clients can detect gaps and ordering. Note (a)'s absent-keys discipline still applies to the pre-game sync.
> hub 2026-08-20, two more: (h) PlayerInputSuspension declares a required response field that never arrives on the wire, because it is undefined at JSON.stringify time; clients should mirror it optional. (i) GetSessionPromptsResponseSchema declares prompts as an array while the route returns an object keyed by player id; recorded only, since those routes are the dead ends of I-5 and nothing should depend on them.

## I-16. Browse-your-own-discard, the TCG pattern — STATUS: PARKED (design, not a blocker)
Many TCGs let a player freely browse their own discard pile at any time, not only peek at the top. Eric's sketch from the 2026-08-19 meeting: model it as a player-scoped discard inventory, possibly using the bag structure where the whole contents are interactable, or alternatively as an action or effect that reveals the pile to its owner. Needs a deliberate choice; none requested now. Client note: the surface's Duel View already renders the opponent's discard as public and browsable per its own visibility law, and an own-discard browse would open in the dock like any other pile browse. First entry of the parking lot requested in the meeting.
> comments:

## I-17. The game-start prompt arrives twice, byte-identical — STATUS: OPEN (design question)
At the moment the last player readies, pushToAwaitedPlayers sends the first prompt as its own frame AND syncAllPlayers then delivers the same pending suspension inside sync.data.prompt, byte-identical, asserted against two captured frames. With no correlation id on the wire, a client can only compare structure to know it is the same question. Ours de-duplicates exactly once and this is fine as permanent client posture; flagging it so the double is a known contract rather than a surprise for the next client. Question: intended, or worth suppressing one of the two?
> comments:

## I-18. A second "ready" restarts a live match — STATUS: OPEN (foot-gun)
handlePlayerReady calls controller.init() whenever all players are ready, and init() rebuilds the session unconditionally with no already-initialized guard. So any stray or duplicate ready from any client silently re-deals a live match. Our client never re-sends ready on reconnect, pinned by its own test, so we cannot trip it, but the guard belongs server-side: one boolean on the session would close the class.
> comments:

## I-19. complete and player-status broadcast to every socket — STATUS: OPEN (recorded contract)
session-manager broadcasts complete (:97) and player-status (:214, :246) to all sockets, so a client driving two seats receives each frame twice and cannot tell a second player's status from a second copy of the first player's without knowing which socket it arrived on. Our channel layer now stamps every broadcast frame with its receiving socket. Fine as wire behavior; recording it as contract, and noting the per-viewer projection work may naturally revisit which frames are broadcast versus addressed.
> comments:

## I-20. No CORS: browsers cannot call the REST half directly — STATUS: OPEN (ask)
The server sends no Access-Control-Allow-Origin header on any route (curl with a browser Origin returns 200 with no ACAO header; the strings cors, access-control and origin appear nowhere in src/; no cors package in dependencies), and an OPTIONS preflight to the create-session route 404s, so even a header on GET would leave the POSTs blocked. Browser console, verbatim: blocked by CORS policy, no Access-Control-Allow-Origin header present. The websocket half is unaffected: a handshake carrying Origin http://localhost:3021 answers 101 and delivers its sync. Our client relays REST through its own origin, allowlisted to the four session routes, so we are unblocked; the ask is CORS middleware plus OPTIONS handling server-side, because every web client ever built will hit this wall until it lands.
> comments: