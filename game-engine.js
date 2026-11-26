/**
 * Point Gomoku — Core Game Engine
 * Inspired by "The Devil's Plan: Dead Again" (Season 3, Episode 13)
 *
 * Rules:
 * - 15x15 Gomoku board (intersections 0..14 x 0..14).
 * - Two players: 'black' (Host / Player 1) and 'white' (Guest / Player 2).
 * - Each round has 3 phases: SELECT -> BET -> REVEAL (then next round or GAME_OVER).
 * - Selection: The current round's selector picks 3 consecutive empty intersections
 *   in a straight line (horizontal, vertical, or diagonal). Selector alternates each round.
 * - Points & Betting:
 *   - Round 1 starts with 10 points each.
 *   - Players secretly bet whole points on each of the 3 spots (A, B, C),
 *     with a minimum of 1 point per spot and total <= available points.
 *   - Carry-over: half of remaining unspent points (rounded down) carries over
 *     to the next round and is added to the 10 new points given each round.
 * - Resolution:
 *   - For each spot, the higher bet wins and places their stone there.
 *   - Tie-breaker: the NON-selector wins any tied spot.
 *   - After all 3 stones are placed, the first player with EXACTLY 5 in a row wins
 *     (overlines of 6 or more do not win and the game continues).
 */

export const BOARD_SIZE = 15;
export const BASE_ROUND_POINTS = 10;
export const SELECTION_TIME_SECONDS = 90;

export const PLAYERS = {
  BLACK: 'black',
  WHITE: 'white',
};

export const PHASES = {
  SELECT: 'SELECT',
  BET: 'BET',
  REVEAL: 'REVEAL',
  GAME_OVER: 'GAME_OVER',
};

export const DIRECTIONS = [
  [0, 1],   // horizontal
  [1, 0],   // vertical
  [1, 1],   // diagonal down-right
  [1, -1],  // diagonal down-left
];

export function opponentOf(player) {
  return player === PLAYERS.BLACK ? PLAYERS.WHITE : PLAYERS.BLACK;
}

export function coordToLabel(r, c) {
  const colChar = String.fromCharCode(65 + c); // A..O
  const rowNum = BOARD_SIZE - r;               // 15..1
  return `${colChar}${rowNum}`;
}

export function createEmptyBoard(size = BOARD_SIZE) {
  return Array.from({ length: size }, () => Array(size).fill(null));
}

export function createInitialState({ startingSelector = PLAYERS.BLACK } = {}) {
  return {
    board: createEmptyBoard(),
    round: 1,
    phase: PHASES.SELECT,
    selector: startingSelector,
    points: {
      [PLAYERS.BLACK]: BASE_ROUND_POINTS,
      [PLAYERS.WHITE]: BASE_ROUND_POINTS,
    },
    selectedSpots: [], // [{ r, c }, { r, c }, { r, c }]
    lastResolution: null,
    history: [],
    winner: null,       // 'black' | 'white' | 'draw' | null
    winningLines: [],   // array of [{ r, c }, ...]
  };
}

export function isInBounds(r, c, size = BOARD_SIZE) {
  return r >= 0 && r < size && c >= 0 && c < size;
}

/**
 * Validates that `spots` contains exactly 3 distinct, empty, in-bounds intersections
 * forming 3 consecutive points in a straight line (horizontal, vertical, or diagonal).
 * Returns { valid: boolean, error?: string, ordered?: [{r, c}, ...] }
 */
export function validateThreeConsecutiveSpots(board, spots) {
  if (!Array.isArray(spots) || spots.length !== 3) {
    return { valid: false, error: 'Must select exactly 3 intersections.' };
  }

  const size = board.length;
  const seen = new Set();
  for (const s of spots) {
    if (!s || typeof s.r !== 'number' || typeof s.c !== 'number') {
      return { valid: false, error: 'Invalid coordinate.' };
    }
    if (!isInBounds(s.r, s.c, size)) {
      return { valid: false, error: 'Coordinate out of bounds.' };
    }
    if (board[s.r][s.c] !== null) {
      return { valid: false, error: `Intersection ${coordToLabel(s.r, s.c)} is already occupied.` };
    }
    const key = `${s.r},${s.c}`;
    if (seen.has(key)) {
      return { valid: false, error: 'Duplicate intersection selected.' };
    }
    seen.add(key);
  }

  // Sort spots canonically (by r, then c) to check consecutiveness cleanly
  const ordered = [...spots].sort((a, b) => (a.r !== b.r ? a.r - b.r : a.c - b.c));
  const dr1 = ordered[1].r - ordered[0].r;
  const dc1 = ordered[1].c - ordered[0].c;
  const dr2 = ordered[2].r - ordered[1].r;
  const dc2 = ordered[2].c - ordered[1].c;

  const isUnitStep =
    Math.abs(dr1) <= 1 &&
    Math.abs(dc1) <= 1 &&
    (dr1 !== 0 || dc1 !== 0);

  if (!isUnitStep || dr1 !== dr2 || dc1 !== dc2) {
    return {
      valid: false,
      error: 'The 3 spots must be consecutive in a straight horizontal, vertical, or diagonal line.',
    };
  }

  return { valid: true, ordered };
}

/**
 * Finds all valid 3-consecutive-empty-spot lines on the board.
 */
export function getAllValidSelections(board) {
  const size = board.length;
  const results = [];

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (board[r][c] !== null) continue;
      for (const [dr, dc] of DIRECTIONS) {
        const r2 = r + dr;
        const c2 = c + dc;
        const r3 = r + 2 * dr;
        const c3 = c + 2 * dc;
        if (
          isInBounds(r3, c3, size) &&
          board[r2][c2] === null &&
          board[r3][c3] === null
        ) {
          results.push([
            { r, c },
            { r: r2, c: c2 },
            { r: r3, c: c3 },
          ]);
        }
      }
    }
  }
  return results;
}

/**
 * Given 0, 1, or 2 currently picked spots, returns the set of `"r,c"` keys
 * that can still be clicked to complete a valid 3-consecutive-empty-spot line.
 */
export function getValidNextSpots(board, currentSpots) {
  const validKeys = new Set();
  const allLines = getAllValidSelections(board);

  if (currentSpots.length === 0) {
    for (const line of allLines) {
      for (const p of line) validKeys.add(`${p.r},${p.c}`);
    }
    return validKeys;
  }

  const pickedKeys = new Set(currentSpots.map((p) => `${p.r},${p.c}`));
  for (const line of allLines) {
    const lineKeys = line.map((p) => `${p.r},${p.c}`);
    let containsAllPicked = true;
    for (const pk of pickedKeys) {
      if (!lineKeys.includes(pk)) {
        containsAllPicked = false;
        break;
      }
    }
    if (containsAllPicked) {
      for (const lk of lineKeys) {
        if (!pickedKeys.has(lk)) validKeys.add(lk);
      }
    }
  }

  return validKeys;
}

/**
 * Validates a player's bet array `[betA, betB, betC]` against their available points.
 */
export function validateBet(bets, availablePoints) {
  if (!Array.isArray(bets) || bets.length !== 3) {
    return { valid: false, error: 'Must submit bets for all 3 spots.' };
  }
  let total = 0;
  for (let i = 0; i < 3; i++) {
    const val = bets[i];
    if (!Number.isInteger(val) || val < 1) {
      return { valid: false, error: 'Each spot requires at least 1 whole point.' };
    }
    total += val;
  }
  if (total > availablePoints) {
    return {
      valid: false,
      error: `Total bet (${total}) exceeds available points (${availablePoints}).`,
    };
  }
  const remaining = availablePoints - total;
  const carryOver = Math.floor(remaining / 2);
  return { valid: true, total, remaining, carryOver };
}

/**
 * Computes next round's points given unspent remaining points.
 */
export function computeNextRoundPoints(remainingPoints) {
  return BASE_ROUND_POINTS + Math.floor(remainingPoints / 2);
}

/**
 * Scans the board for any EXACTLY 5-in-a-row for either player.
 * Overlines of 6 or more in a row do NOT win.
 * Returns { blackLines, whiteLines } where each line is an array of {r, c}.
 */
export function findWinningLines(board) {
  const size = board.length;
  const blackLines = [];
  const whiteLines = [];

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const stone = board[r][c];
      if (!stone) continue;

      for (const [dr, dc] of DIRECTIONS) {
        // Only start counting from the beginning of a contiguous run
        const prevR = r - dr;
        const prevC = c - dc;
        if (isInBounds(prevR, prevC, size) && board[prevR][prevC] === stone) {
          continue;
        }

        const run = [{ r, c }];
        let nr = r + dr;
        let nc = c + dc;
        while (isInBounds(nr, nc, size) && board[nr][nc] === stone) {
          run.push({ r: nr, c: nc });
          nr += dr;
          nc += dc;
        }

        if (run.length === 5) {
          if (stone === PLAYERS.BLACK) blackLines.push(run);
          else whiteLines.push(run);
        }
      }
    }
  }

  return { blackLines, whiteLines };
}

/**
 * Applies the selector's 3-spot choice to the state and transitions to BET phase.
 */
export function applySelection(state, spots) {
  if (state.phase !== PHASES.SELECT) {
    throw new Error('Cannot select spots outside the SELECT phase.');
  }
  const check = validateThreeConsecutiveSpots(state.board, spots);
  if (!check.valid) {
    throw new Error(check.error);
  }
  return {
    ...state,
    phase: PHASES.BET,
    selectedSpots: check.ordered,
  };
}

/**
 * Resolves a round given both players' bets:
 * `bets = { black: [a, b, c], white: [a, b, c] }`
 * Returns a new state in either REVEAL or GAME_OVER phase.
 */
export function resolveRound(state, bets) {
  if (state.phase !== PHASES.BET) {
    throw new Error('Cannot resolve bets outside the BET phase.');
  }

  const blackCheck = validateBet(bets[PLAYERS.BLACK], state.points[PLAYERS.BLACK]);
  if (!blackCheck.valid) {
    throw new Error(`Invalid Black bet: ${blackCheck.error}`);
  }
  const whiteCheck = validateBet(bets[PLAYERS.WHITE], state.points[PLAYERS.WHITE]);
  if (!whiteCheck.valid) {
    throw new Error(`Invalid White bet: ${whiteCheck.error}`);
  }

  const newBoard = state.board.map((row) => [...row]);
  const nonSelector = opponentOf(state.selector);
  const outcomes = [];

  for (let i = 0; i < 3; i++) {
    const spot = state.selectedSpots[i];
    const blackBet = bets[PLAYERS.BLACK][i];
    const whiteBet = bets[PLAYERS.WHITE][i];
    let spotWinner;
    let wasTie = false;

    if (blackBet > whiteBet) {
      spotWinner = PLAYERS.BLACK;
    } else if (whiteBet > blackBet) {
      spotWinner = PLAYERS.WHITE;
    } else {
      wasTie = true;
      spotWinner = nonSelector;
    }

    newBoard[spot.r][spot.c] = spotWinner;
    outcomes.push({
      label: ['A', 'B', 'C'][i],
      spot,
      coord: coordToLabel(spot.r, spot.c),
      blackBet,
      whiteBet,
      winner: spotWinner,
      wasTie,
    });
  }

  const { blackLines, whiteLines } = findWinningLines(newBoard);
  let winner = null;
  let winningLines = [];

  if (blackLines.length > 0 && whiteLines.length > 0) {
    winner = 'draw';
    winningLines = [...blackLines, ...whiteLines];
  } else if (blackLines.length > 0) {
    winner = PLAYERS.BLACK;
    winningLines = blackLines;
  } else if (whiteLines.length > 0) {
    winner = PLAYERS.WHITE;
    winningLines = whiteLines;
  } else if (getAllValidSelections(newBoard).length === 0) {
    winner = 'draw';
  }

  const nextPoints = {
    [PLAYERS.BLACK]: computeNextRoundPoints(blackCheck.remaining),
    [PLAYERS.WHITE]: computeNextRoundPoints(whiteCheck.remaining),
  };

  const resolution = {
    round: state.round,
    selector: state.selector,
    nonSelector,
    outcomes,
    spent: {
      [PLAYERS.BLACK]: blackCheck.total,
      [PLAYERS.WHITE]: whiteCheck.total,
    },
    remaining: {
      [PLAYERS.BLACK]: blackCheck.remaining,
      [PLAYERS.WHITE]: whiteCheck.remaining,
    },
    carryOver: {
      [PLAYERS.BLACK]: blackCheck.carryOver,
      [PLAYERS.WHITE]: whiteCheck.carryOver,
    },
    nextPoints,
  };

  return {
    ...state,
    board: newBoard,
    phase: winner ? PHASES.GAME_OVER : PHASES.REVEAL,
    lastResolution: resolution,
    history: [resolution, ...state.history],
    winner,
    winningLines,
  };
}

/**
 * Advances from REVEAL to the next round's SELECT phase.
 */
export function advanceToNextRound(state) {
  if (state.phase !== PHASES.REVEAL) {
    throw new Error('Can only advance from REVEAL phase.');
  }
  return {
    ...state,
    round: state.round + 1,
    phase: PHASES.SELECT,
    selector: opponentOf(state.selector),
    points: { ...state.lastResolution.nextPoints },
    selectedSpots: [],
  };
}

/**
 * Cryptographic commit helper (SHA-256 hex) for fair P2P simultaneous betting.
 */
export async function hashBetCommit(round, bets, nonce) {
  const payload = JSON.stringify({ round, bets, nonce });
  const encoded = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Simple strategic AI for Practice vs Bot mode.
 */
export function chooseBotSelection(board, botPlayer) {
  const validLines = getAllValidSelections(board);
  if (validLines.length === 0) return null;

  const opp = opponentOf(botPlayer);
  const center = Math.floor(board.length / 2);

  let bestScore = -Infinity;
  let bestLines = [];

  for (const line of validLines) {
    let score = 0;
    for (const { r, c } of line) {
      // Favor center early
      const dist = Math.abs(r - center) + Math.abs(c - center);
      score += Math.max(0, 12 - dist) * 0.4;

      // Check proximity to own and opponent stones
      for (const [dr, dc] of DIRECTIONS) {
        let ownCount = 0;
        let oppCount = 0;
        for (let step = -4; step <= 4; step++) {
          if (step === 0) continue;
          const nr = r + dr * step;
          const nc = c + dc * step;
          if (!isInBounds(nr, nc, board.length)) continue;
          if (board[nr][nc] === botPlayer) ownCount++;
          else if (board[nr][nc] === opp) oppCount++;
        }
        score += ownCount * ownCount * 3.5;
        score += oppCount * oppCount * 2.2;
      }
    }
    if (score > bestScore + 0.01) {
      bestScore = score;
      bestLines = [line];
    } else if (Math.abs(score - bestScore) <= 0.01) {
      bestLines.push(line);
    }
  }

  return bestLines[Math.floor(Math.random() * bestLines.length)];
}

export function chooseBotBet(state, botPlayer) {
  const available = state.points[botPlayer];
  const opp = opponentOf(botPlayer);
  const spots = state.selectedSpots;
  const isSelector = state.selector === botPlayer;

  // Evaluate urgency of each of the 3 spots
  const weights = spots.map(({ r, c }) => {
    let w = 1;
    // Simulate placing own stone or opponent stone
    const testOwn = state.board.map((row) => [...row]);
    testOwn[r][c] = botPlayer;
    const ownWin = findWinningLines(testOwn);
    if ((botPlayer === PLAYERS.BLACK ? ownWin.blackLines : ownWin.whiteLines).length > 0) {
      w += 40;
    }

    const testOpp = state.board.map((row) => [...row]);
    testOpp[r][c] = opp;
    const oppWin = findWinningLines(testOpp);
    if ((opp === PLAYERS.BLACK ? oppWin.blackLines : oppWin.whiteLines).length > 0) {
      w += 35;
    }

    // Check adjacency to existing stones
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr;
        const nc = c + dc;
        if (!isInBounds(nr, nc, state.board.length)) continue;
        if (state.board[nr][nc] === botPlayer) w += dr === 0 || dc === 0 || Math.abs(dr) === Math.abs(dc) ? 2.5 : 0.8;
        if (state.board[nr][nc] === opp) w += dr === 0 || dc === 0 || Math.abs(dr) === Math.abs(dc) ? 2.0 : 0.6;
      }
    }
    return w;
  });

  const maxWeight = Math.max(...weights);
  // Decide whether to hoard points (Jung Won-young style!) or spend heavily
  let spendBudget;
  if (maxWeight >= 30) {
    spendBudget = available; // critical win/block spot — go all-in
  } else if (state.round <= 2 && available <= 12) {
    // Hoard some points early for carry-over advantage
    spendBudget = Math.max(3, Math.min(available, Math.floor(available * 0.55)));
  } else {
    const ratio = isSelector ? 0.75 : 0.65;
    spendBudget = Math.max(3, Math.min(available, Math.round(available * (ratio + (Math.random() * 0.2 - 0.1)))));
  }

  // Start with minimum 1 on each spot
  const bets = [1, 1, 1];
  let extra = spendBudget - 3;

  // Distribute remaining budget proportionally to weights with slight randomness
  const noisyWeights = weights.map((w) => w * (0.85 + Math.random() * 0.3));
  const sumW = noisyWeights.reduce((a, b) => a + b, 0);

  for (let i = 0; i < 3; i++) {
    const share = Math.floor((noisyWeights[i] / sumW) * extra);
    bets[i] += share;
  }
  let leftover = spendBudget - (bets[0] + bets[1] + bets[2]);
  // Give leftover to highest-weight spot
  const bestIdx = noisyWeights.indexOf(Math.max(...noisyWeights));
  bets[bestIdx] += leftover;

  return bets;
}
