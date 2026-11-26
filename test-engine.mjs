import assert from 'node:assert/strict';
import {
  PLAYERS,
  PHASES,
  createInitialState,
  validateThreeConsecutiveSpots,
  getValidNextSpots,
  validateBet,
  computeNextRoundPoints,
  applySelection,
  resolveRound,
  advanceToNextRound,
  hashBetCommit,
  chooseBotSelection,
  chooseBotBet,
} from './game-engine.js';

async function runTests() {
  // 1. Initial state
  let state = createInitialState();
  assert.equal(state.round, 1);
  assert.equal(state.phase, PHASES.SELECT);
  assert.equal(state.selector, PLAYERS.BLACK);
  assert.equal(state.points.black, 10);
  assert.equal(state.points.white, 10);

  // 2. Three consecutive spot validation (horizontal, vertical, diagonals, invalid)
  assert.equal(
    validateThreeConsecutiveSpots(state.board, [
      { r: 7, c: 6 },
      { r: 7, c: 7 },
      { r: 7, c: 8 },
    ]).valid,
    true
  );
  assert.equal(
    validateThreeConsecutiveSpots(state.board, [
      { r: 5, c: 5 },
      { r: 6, c: 6 },
      { r: 7, c: 7 },
    ]).valid,
    true
  );
  assert.equal(
    validateThreeConsecutiveSpots(state.board, [
      { r: 5, c: 7 },
      { r: 6, c: 6 },
      { r: 7, c: 5 },
    ]).valid,
    true
  );
  // Non-consecutive gap
  assert.equal(
    validateThreeConsecutiveSpots(state.board, [
      { r: 7, c: 6 },
      { r: 7, c: 7 },
      { r: 7, c: 9 },
    ]).valid,
    false
  );
  // Bent L-shape
  assert.equal(
    validateThreeConsecutiveSpots(state.board, [
      { r: 7, c: 6 },
      { r: 7, c: 7 },
      { r: 8, c: 7 },
    ]).valid,
    false
  );

  // 3. Valid next spots helper
  const nextAfterTwo = getValidNextSpots(state.board, [
    { r: 7, c: 7 },
    { r: 7, c: 8 },
  ]);
  assert.equal(nextAfterTwo.has('7,6'), true);
  assert.equal(nextAfterTwo.has('7,9'), true);
  assert.equal(nextAfterTwo.size, 2);

  // 4. Bet validation & carry-over math
  assert.equal(validateBet([0, 5, 5], 10).valid, false, 'Min 1 pt per spot');
  assert.equal(validateBet([4, 4, 3], 10).valid, false, 'Cannot exceed available points');
  const hoarding = validateBet([1, 1, 1], 10);
  assert.equal(hoarding.valid, true);
  assert.equal(hoarding.remaining, 7);
  assert.equal(hoarding.carryOver, 3, 'floor(7/2) === 3');
  assert.equal(computeNextRoundPoints(7), 13);

  // 5. Round resolution & tie-breaker (non-selector wins ties!)
  state = applySelection(state, [
    { r: 7, c: 6 },
    { r: 7, c: 7 },
    { r: 7, c: 8 },
  ]);
  assert.equal(state.phase, PHASES.BET);

  // Black is selector, White is non-selector
  // Spot A: Black 4 vs White 2 -> Black
  // Spot B: Black 3 vs White 3 -> TIE -> White (non-selector)
  // Spot C: Black 1 vs White 2 -> White
  state = resolveRound(state, {
    black: [4, 3, 1], // total 8, remaining 2 -> carry 1 -> next 11
    white: [2, 3, 2], // total 7, remaining 3 -> carry 1 -> next 11
  });
  assert.equal(state.phase, PHASES.REVEAL);
  assert.equal(state.board[7][6], PLAYERS.BLACK);
  assert.equal(state.board[7][7], PLAYERS.WHITE);
  assert.equal(state.board[7][8], PLAYERS.WHITE);
  assert.equal(state.lastResolution.outcomes[1].wasTie, true);
  assert.equal(state.lastResolution.outcomes[1].winner, PLAYERS.WHITE);
  assert.equal(state.lastResolution.nextPoints.black, 11);
  assert.equal(state.lastResolution.nextPoints.white, 11);

  // 6. Advancing round alternates selector
  state = advanceToNextRound(state);
  assert.equal(state.round, 2);
  assert.equal(state.selector, PLAYERS.WHITE);
  assert.equal(state.points.black, 11);
  assert.equal(state.points.white, 11);

  // 7. Occupied intersection cannot be selected
  assert.equal(
    validateThreeConsecutiveSpots(state.board, [
      { r: 7, c: 8 },
      { r: 7, c: 9 },
      { r: 7, c: 10 },
    ]).valid,
    false
  );

  // 8. 5-in-a-row win detection
  let winState = createInitialState();
  // Round 1: Black wins (7,4), (7,5), (7,6)
  winState = applySelection(winState, [
    { r: 7, c: 4 },
    { r: 7, c: 5 },
    { r: 7, c: 6 },
  ]);
  winState = resolveRound(winState, {
    black: [4, 3, 3],
    white: [1, 1, 1],
  });
  assert.equal(winState.phase, PHASES.REVEAL);
  winState = advanceToNextRound(winState);

  // Round 2: Black wins (7,7), (7,8) -> 5 in a row!
  winState = applySelection(winState, [
    { r: 7, c: 7 },
    { r: 7, c: 8 },
    { r: 7, c: 9 },
  ]);
  winState = resolveRound(winState, {
    black: [4, 4, 2],
    white: [1, 1, 10],
  });
  assert.equal(winState.phase, PHASES.GAME_OVER);
  assert.equal(winState.winner, PLAYERS.BLACK);
  assert.equal(winState.winningLines.length, 1);
  assert.equal(winState.winningLines[0].length, 5);

  // 8b. 6-in-a-row overline does NOT win (game continues)
  let overlineState = createInitialState();
  overlineState = applySelection(overlineState, [
    { r: 5, c: 3 },
    { r: 5, c: 4 },
    { r: 5, c: 5 },
  ]);
  overlineState = resolveRound(overlineState, {
    black: [4, 3, 3],
    white: [1, 1, 1],
  });
  overlineState = advanceToNextRound(overlineState);
  overlineState = applySelection(overlineState, [
    { r: 5, c: 6 },
    { r: 5, c: 7 },
    { r: 5, c: 8 },
  ]);
  overlineState = resolveRound(overlineState, {
    black: [4, 3, 3],
    white: [1, 1, 1],
  });
  assert.equal(overlineState.phase, PHASES.REVEAL, '6-in-a-row must not end the game');
  assert.equal(overlineState.winner, null);
  assert.equal(overlineState.winningLines.length, 0);

  // 9. Cryptographic commit-reveal hash determinism
  const h1 = await hashBetCommit(1, [4, 3, 3], 'abc123');
  const h2 = await hashBetCommit(1, [4, 3, 3], 'abc123');
  const h3 = await hashBetCommit(1, [4, 3, 2], 'abc123');
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.equal(h1.length, 64);

  // 10. Bot selection & bet validity
  const botSel = chooseBotSelection(state.board, PLAYERS.WHITE);
  assert.equal(validateThreeConsecutiveSpots(state.board, botSel).valid, true);
  const stateForBotBet = applySelection(state, botSel);
  const botBet = chooseBotBet(stateForBotBet, PLAYERS.WHITE);
  assert.equal(validateBet(botBet, stateForBotBet.points.white).valid, true);

  console.log('All Point Gomoku engine tests passed! (10/10)');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
