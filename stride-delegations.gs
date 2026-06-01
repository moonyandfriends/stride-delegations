// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// Stride host_zone endpoint (Polkachu)
const STRIDE_API_URL =
  'https://stride-api.polkachu.com/Stride-Labs/stride/stakeibc/host_zone';

const BONDED_STATUS = 'BOND_STATUS_BONDED';

// Flagship chains that also require uptime + governance checks
const FLAGSHIP_CHAIN_IDS = [
  'cosmoshub-4',      // Cosmos Hub
  'osmosis-1',        // Osmosis
  'celestia',         // Celestia
  'dydx-mainnet-1',   // dYdX
];

// Host zones to exclude from the spreadsheet entirely (no sheet created),
// even if Stride still returns them from the host_zone endpoint.
const EXCLUDED_CHAIN_IDS = [
  'umee-1',         // Umee / UX
  'stargaze-1',     // Stargaze
  'comdex-1',       // Comdex
  'evmos_9001-2',   // Evmos
];

// For auto-filling uptime + governance with VLOOKUP
const FLAGSHIP_UPTIME_SHEET_BY_CHAIN_ID = {
  'cosmoshub-4': 'cosmos-uptime+governance',
  'osmosis-1': 'osmosis-uptime+governance',
  'celestia': 'celestia-uptime+governance',
  'dydx-mainnet-1': 'dydx-uptime+governance',
};

// Map Stride host_zone.chain_id -> cosmos.directory network name
const CHAIN_ID_TO_NETWORK = {
  'cosmoshub-4': 'cosmoshub',
  'celestia': 'celestia',
  'dydx-mainnet-1': 'dydx',
  'injective-1': 'injective',
  'haqq_11235-1': 'haqq',
  'juno-1': 'juno',

  // Bandchain  keep only laozi-mainnet
  'laozi-mainnet': 'bandchain',

  'osmosis-1': 'osmosis',
  'phoenix-1': 'terra2',
  'sommelier-3': 'sommelier',

  // Saga  support both possible chain IDs
  'saga-1': 'saga',
  'ssc-1': 'saga',
};

// -----------------------------------------------------------------------------
// Stride "proof-of-authority" partner validators
// -----------------------------------------------------------------------------
//
// These are operators in Stride's own validator set on other chains. We support
// them by always delegating to them on the chains we stake to. A validator whose
// moniker matches one of these (case-insensitive substring) is force-included as
// eligible regardless of commission, stake rank, governance, or uptime checks.
//
// The only criterion still enforced is BONDED status: you cannot meaningfully
// delegate to an unbonded/jailed validator.
//
// Patterns are intentionally short substrings to survive moniker variations across
// chains (e.g. "Lavender.Five", "Lavender.Five Nodes 🍀"; "Imperator.co";
// "Polkachu.com"; "Solva" / "CryptoCrew"). Keep them specific enough to avoid
// matching unrelated monikers.
const POA_PARTNER_PATTERNS = [
  'cosmostation',
  'keplr',
  'imperator',
  'stakecito',
  'polkachu',
  'lavender.five',
  'lavenderfive',
  'cryptocrew',  // Solva was formerly branded CryptoCrew
  'solva',
];

// Validators whose moniker signals they are winding down or do not want
// delegations are excluded outright. Matched as case-insensitive substrings
// (whitespace collapsed) anywhere in the moniker. This exclusion takes
// precedence over PoA-partner force-inclusion: a partner that is shutting down
// a validator on a given chain should not receive a forced delegation.
const EXCLUDED_NAME_PATTERNS = [
  'redelegate',
  're-delegate',
  'undelegate',
  'do not delegate',
  'closing',
  'shut down',
  'shutdown',
  'shutting down',
  'sunsetting',
  'decommissioned',
  'discontinued',
  'deprecating',
  'depreciating',
  'inactive',
  'deactivated',
];

// Per-chain maximum commission (decimal). Celestia raised its protocol-minimum
// commission to 20%, so validators there are allowed up to 20% (validators with
// strictly more than 20% are excluded; exactly 20% stays eligible). All other
// chains keep the 10% cap.
const DEFAULT_MAX_COMMISSION = 0.10;
const MAX_COMMISSION_BY_CHAIN_ID = {
  'celestia': 0.20,
};

function maxCommissionForChainId(chainId) {
  const cap = MAX_COMMISSION_BY_CHAIN_ID[chainId];
  return cap != null ? cap : DEFAULT_MAX_COMMISSION;
}

// Column indices (1-based)
const COL_NAME            = 1;  // A: Validator Name
const COL_ADDRESS         = 2;  // B: Validator Address
const COL_STRIDE          = 3;  // C: Stride Delegations
const COL_LIVE            = 4;  // D: Live Delegations
const COL_DELTA           = 5;  // E: Delegations Minus Stride
const COL_COMMISSION      = 6;  // F: Commission
const COL_CEX             = 7;  // G: CEX
const COL_ACTIVE          = 8;  // H: Active
const COL_UPTIME          = 9;  // I: Uptime
const COL_GOV             = 10; // J: Governance
const COL_ELIG            = 11; // K: Eligibility
const COL_REASON          = 12; // L: Reason
const COL_CURRENT_WEIGHT  = 13; // M: Current Weight
const COL_NEW_WEIGHT      = 14; // N: New Weight

const LAST_COLUMN = COL_NEW_WEIGHT;

// -----------------------------------------------------------------------------
// Menu
// -----------------------------------------------------------------------------

function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('Stride')
      .addItem('Refresh host_zones + live data', 'refreshStrideHostZones')
      .addItem(
        'Apply flagship eligibility (gov + uptime)',
        'applyFlagshipEligibilityForActiveSheet'
      )
      .addToUi();
  } catch (err) {
    // If run from script editor, UI may not be available; ignore.
    Logger.log('onOpen called without UI context: ' + err);
  }
}

// -----------------------------------------------------------------------------
// Main refresh
// -----------------------------------------------------------------------------

function refreshStrideHostZones() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const hostZones = fetchStrideHostZones();
  if (!hostZones.length) {
    SpreadsheetApp.getUi().alert('No host_zone data returned from Stride.');
    return;
  }

  createStrideSheetsWithLiveData(ss, hostZones);
}

function fetchStrideHostZones() {
  const response = UrlFetchApp.fetch(STRIDE_API_URL, {
    muteHttpExceptions: true,
  });

  if (response.getResponseCode() !== 200) {
    SpreadsheetApp.getUi().alert(
      'Error fetching Stride data: HTTP ' + response.getResponseCode()
    );
    return [];
  }

  const data = JSON.parse(response.getContentText());
  return data.host_zone || [];
}

// -----------------------------------------------------------------------------
// Capped weights helpers (Variant B dynamic cap)
// -----------------------------------------------------------------------------

/**
 * Capped proportional allocation ("water-filling").
 *
 * stakes:     array of non-negative numbers (e.g. Delegations Minus Stride for eligible validators)
 * capFraction: maximum allowed weight per validator (e.g. 0.08 for 8%)
 *
 * Returns an array of weights of the same length, summing to 1 (or 0 if all stakes are 0),
 * with each weight <= capFraction.
 */
function computeCappedWeights(stakes, capFraction) {
  const n = stakes.length;
  const weights = new Array(n).fill(0);
  if (!n) return weights;

  let remainingMass = 1; // total weight we want to distribute
  let remainingTotal = stakes.reduce((sum, x) => sum + x, 0);
  const active = new Array(n).fill(true);

  if (remainingTotal <= 0) {
    return weights; // all zero stakes -> all weights 0
  }

  while (true) {
    let anyCapped = false;

    const baseFactor = remainingMass / remainingTotal;

    // First pass: see who would exceed the cap and cap them
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;

      const wCandidate = stakes[i] * baseFactor; // unconstrained proportional weight

      if (wCandidate > capFraction + 1e-12) {
        weights[i] = capFraction;
        active[i] = false;
        remainingMass -= capFraction;
        remainingTotal -= stakes[i];
        anyCapped = true;
      }
    }

    // If nobody exceeded the cap this round, just assign remaining proportionally and finish
    if (!anyCapped || remainingMass <= 1e-9 || remainingTotal <= 0) {
      if (remainingMass > 0 && remainingTotal > 0) {
        const finalFactor = remainingMass / remainingTotal;
        for (let i = 0; i < n; i++) {
          if (!active[i]) continue;
          weights[i] = stakes[i] * finalFactor;
        }
      }
      break;
    }
  }

  return weights;
}

/**
 * Dynamic per-validator cap as a fraction (01) based on the
 * number of eligible validators, using Variant B with a
 * feasibility constraint:
 *
 *   softCap(N) = 8% * (32 / N)^0.5
 *   cap(N)     = max( softCap(N), 1 / N )
 *
 * This guarantees there is always a valid allocation that
 * sums to 100% while respecting the cap.
 */
function computeDynamicCapFraction(nEligible) {
  if (nEligible <= 0) return 0;

  const baseCap = 0.08;   // 8% when N = 32
  const alpha = 0.5;      // sqrt scaling
  const Nref = 32;

  // Variant B "soft" cap
  let capSoft = baseCap * Math.pow(Nref / nEligible, alpha);

  // Minimum cap needed to be able to allocate 100% of stake
  const capMin = 1 / nEligible;

  // Final cap: cannot be below 1/N (otherwise full allocation is impossible)
  const cap = Math.max(capSoft, capMin);

  return cap;
}

// -----------------------------------------------------------------------------
// Build sheets for each host zone
// -----------------------------------------------------------------------------

/**
 * For each host_zone, create a sheet with merged Stride + live chain data.
 *
 * Universal criteria (all chains):
 *  - Active (BOND_STATUS_BONDED)
 *  - Not a known CEX
 *  - Commission rate <= 10%
 *  - Not in the bottom 5% of the active set by stake (excluding Stride)
 *  - If active set has:
 *       64+ validators  exclude top 8 by stake (excl. Stride)
 *       98+ validators  exclude top 12
 *       132+ validators  exclude top 16
 *
 * Then apply a 32-validator cap per chain:
 *  - Among validators that pass universal criteria, sort by Delegations Minus Stride
 *    (stake excluding Stride) descending, and only the top 32 remain finally eligible.
 *  - Others get reason "over_32_cap".
 *
 * For flagship chains, we only compute universal + reasons here; final eligibility
 * (gov + uptime + 32-cap) and New Weight are applied later via the menu.
 */
function createStrideSheetsWithLiveData(ss, hostZones) {
  hostZones.forEach((hz) => {
    const chainId = hz.chain_id || '';
    const rawName = chainId || hz.host_denom || 'host_zone';
    const sheetName = sanitizeSheetName(rawName);
    const isFlagship = FLAGSHIP_CHAIN_IDS.indexOf(chainId) !== -1;
    const maxCommission = maxCommissionForChainId(chainId);

    // Skip excluded host zones entirely. Remove any stale sheet left from a
    // previous refresh, then move on without creating a new one.
    if (EXCLUDED_CHAIN_IDS.indexOf(chainId) !== -1) {
      const stale = ss.getSheetByName(sheetName);
      if (stale) {
        ss.deleteSheet(stale);
      }
      return;
    }

    // Delete old sheet if it exists
    const existing = ss.getSheetByName(sheetName);
    if (existing) {
      ss.deleteSheet(existing);
    }

    const sheet = ss.insertSheet(sheetName);

    // Header row
    sheet.getRange(1, COL_NAME).setValue('Validator Name');
    sheet.getRange(1, COL_ADDRESS).setValue('Validator Address');
    sheet.getRange(1, COL_STRIDE).setValue('Stride Delegations');
    sheet.getRange(1, COL_LIVE).setValue('Live Delegations');
    sheet.getRange(1, COL_DELTA).setValue('Delegations Minus Stride');
    sheet.getRange(1, COL_COMMISSION).setValue('Commission');
    sheet.getRange(1, COL_CEX).setValue('CEX');
    sheet.getRange(1, COL_ACTIVE).setValue('Active');
    sheet.getRange(1, COL_UPTIME).setValue('Uptime');
    sheet.getRange(1, COL_GOV).setValue('Governance');
    sheet.getRange(1, COL_ELIG).setValue('Eligibility');
    sheet.getRange(1, COL_REASON).setValue('Reason');
    sheet.getRange(1, COL_CURRENT_WEIGHT).setValue('Current Weight');
    sheet.getRange(1, COL_NEW_WEIGHT).setValue('New Weight');

    const lastColumn = LAST_COLUMN;

    // Style header row
    sheet.getRange(1, 1, 1, lastColumn).setFontWeight('bold');
    sheet.setFrozenRows(1);

    const strideValidators = hz.validators || [];
    const liveValidators = fetchLiveValidatorsForHostZone(hz);

    // Merge Stride + live validators into structured rows
    let rows = buildMergedValidatorRows(strideValidators, liveValidators);

    // --- Universal eligibility (on-chain criteria only) ---

    // Active set (for stake-based top/bottom calculations) by status
    const activeRows = rows.filter((r) => r.status === BONDED_STATUS);
    const nActive = activeRows.length;

    const bottomSet = new Set();
    const topSet = new Set();

    if (nActive > 0) {
      // Sort active by ascending non-Stride stake for bottom 5%
      const activeAsc = [...activeRows].sort(
        (a, b) => a.deltaNoStride - b.deltaNoStride
      );
      const bottomCount = Math.floor(nActive * 0.05);
      for (let i = 0; i < bottomCount; i++) {
        if (activeAsc[i]) bottomSet.add(activeAsc[i].address);
      }

      // Sort active by descending non-Stride stake for top-cap exclusions
      const activeDesc = [...activeRows].sort(
        (a, b) => b.deltaNoStride - a.deltaNoStride
      );

      let topN = 0;
      if (nActive >= 132) {
        topN = 16;
      } else if (nActive >= 98) {
        topN = 12;
      } else if (nActive >= 64) {
        topN = 8;
      }

      for (let i = 0; i < topN; i++) {
        if (activeDesc[i]) topSet.add(activeDesc[i].address);
      }
    }

    // Per-row universal eligibility + reasons
    rows.forEach((r) => {
      let universalEligible = true;
      const reasons = [];

      if (r.status !== BONDED_STATUS) {
        universalEligible = false;
        reasons.push('inactive');
      }

      if (r.isCex) {
        universalEligible = false;
        reasons.push('CEX');
      }

      if (r.commissionRate == null || isNaN(r.commissionRate)) {
        universalEligible = false;
        reasons.push('no_commission');
      } else if (r.commissionRate > maxCommission + 1e-9) {
        universalEligible = false;
        reasons.push('commission>' + Math.round(maxCommission * 100) + '%');
      }

      if (bottomSet.has(r.address)) {
        universalEligible = false;
        reasons.push('bottom_5%_stake');
      }

      if (topSet.has(r.address)) {
        universalEligible = false;
        reasons.push('top_N_stake');
      }

      if (r.nameExclusion) {
        universalEligible = false;
        reasons.push('name_excluded (' + r.nameExclusion + ')');
      }

      r.universalEligible = universalEligible;
      r.reasons = reasons; // may be empty

      // Stride PoA partners are always included as long as they are bonded,
      // regardless of commission / stake rank / (gov + uptime on flagship).
      // A "winding down / do not delegate" moniker overrides force-inclusion.
      r.forceInclude =
        r.isPoaPartner && r.status === BONDED_STATUS && !r.nameExclusion;

      r.finalEligible = false; // filled below for non-flagship
    });

    // --- 32-validator global cap (non-flagship only at this stage) ---
    //
    // Forced PoA partners always occupy a slot. They count *within* the 32, so
    // the remaining slots are filled by the top regular-eligible validators by
    // stake (Delegations Minus Stride).

    if (!isFlagship) {
      const forced = rows.filter((r) => r.forceInclude);
      const slotsForRegular = Math.max(0, 32 - forced.length);

      const regularEligible = rows.filter(
        (r) => r.universalEligible && !r.forceInclude
      );
      regularEligible.sort((a, b) => b.deltaNoStride - a.deltaNoStride);

      const allowedRegular = new Set(
        regularEligible.slice(0, slotsForRegular).map((r) => r.address)
      );

      rows.forEach((r) => {
        if (r.forceInclude) {
          r.finalEligible = true;
          r.reasons = []; // force-included; clear any ineligibility reasons
        } else if (r.universalEligible && allowedRegular.has(r.address)) {
          r.finalEligible = true;
        } else if (r.universalEligible) {
          r.finalEligible = false;
          r.reasons.push('over_32_cap');
        } else {
          r.finalEligible = false;
        }
      });
    }

    // Sort ALL validators by Delegations Minus Stride (largest first)
    rows.sort((a, b) => b.deltaNoStride - a.deltaNoStride);

    let lastRow = 1; // at least header

    if (rows.length > 0) {
      const numRows = rows.length;

      // Write A..D values
      const outputAD = rows.map((r) => [
        r.name,
        r.address,
        r.strideDelegationStr,
        r.liveTokensStr,
      ]);
      sheet.getRange(2, COL_NAME, numRows, 4).setValues(outputAD);

      // Column E: Delegations Minus Stride = D - C
      const formulaRange = sheet.getRange(2, COL_DELTA, numRows, 1);
      const formulas = [];
      for (let i = 0; i < numRows; i++) {
        // R1C1: D(row) - C(row)
        formulas.push(['=R[0]C[-1]-R[0]C[-2]']);
      }
      formulaRange.setFormulasR1C1(formulas);

      // Column F: Commission (decimal as %)
      const commissionValues = rows.map((r) => {
        if (r.commissionRate == null || isNaN(r.commissionRate)) {
          return [null];
        }
        return [r.commissionRate];
      });
      sheet.getRange(2, COL_COMMISSION, numRows, 1).setValues(commissionValues);

      // Column G: CEX
      const cexValues = rows.map((r) => [r.isCex ? 'Y' : 'N']);
      sheet.getRange(2, COL_CEX, numRows, 1).setValues(cexValues);

      // Column H: Active
      const activeValues = rows.map((r) => [
        r.status === BONDED_STATUS ? 'Y' : 'N',
      ]);
      sheet.getRange(2, COL_ACTIVE, numRows, 1).setValues(activeValues);

      // Columns I (Uptime) and J (Governance):
      // Clear existing, then auto-fill VLOOKUP formulas for flagship chains.
      sheet.getRange(2, COL_UPTIME, numRows, 2).clearContent();

      if (isFlagship) {
        const lookupSheet = FLAGSHIP_UPTIME_SHEET_BY_CHAIN_ID[chainId];
        if (lookupSheet) {
          const uptimeRange = sheet.getRange(2, COL_UPTIME, numRows, 1);
          const govRange = sheet.getRange(2, COL_GOV, numRows, 1);

          const uptimeFormulas = [];
          const govFormulas = [];

          // From Uptime (col I=9): RC[-8] points to col A (Validator Name)
          const uptimeFormulaR1C1 =
            "=IFERROR(VLOOKUP(R[0]C[-8],'" +
            lookupSheet +
            "'!C1:C3,3,FALSE),\"\")";

          // From Governance (col J=10): RC[-9] points to col A
          const govFormulaR1C1 =
            "=IFERROR(VLOOKUP(R[0]C[-9],'" +
            lookupSheet +
            "'!C1:C3,2,FALSE),\"\")";

          for (let i = 0; i < numRows; i++) {
            uptimeFormulas.push([uptimeFormulaR1C1]);
            govFormulas.push([govFormulaR1C1]);
          }

          uptimeRange.setFormulasR1C1(uptimeFormulas);
          govRange.setFormulasR1C1(govFormulas);
        }
      }

      // Column K: Eligibility
      // Column L: Reason
      let eligibilityValues;
      let reasonValues;

      if (isFlagship) {
        // Universal-only information; final eligibility will be filled via menu
        eligibilityValues = rows.map(() => ['']);
        reasonValues = rows.map((r) => {
          if (r.forceInclude) {
            return ['force_included (PoA partner) — run flagship eligibility tool'];
          }
          return [
            r.universalEligible
              ? 'universal_OK (run flagship eligibility tool)'
              : (r.reasons.join(', ') || 'ineligible_unknown'),
          ];
        });
      } else {
        eligibilityValues = rows.map((r) => [r.finalEligible ? 'Y' : 'N']);
        reasonValues = rows.map((r) => {
          if (r.forceInclude) return ['force_included (PoA partner)'];
          return [
            r.finalEligible ? 'OK' : (r.reasons.join(', ') || 'ineligible_unknown'),
          ];
        });
      }

      sheet.getRange(2, COL_ELIG, numRows, 1).setValues(eligibilityValues);
      sheet.getRange(2, COL_REASON, numRows, 1).setValues(reasonValues);

      // --- Current Weight + New Weight (with dynamic cap on non-flagship chains) ---

      // Current Weight: share of Stride's delegations on that chain.
      const totalStrideDelegations = rows.reduce(
        (sum, r) => sum + (r.strideDelegationNum || 0),
        0
      );

      const currentWeightValues = rows.map((r) => {
        if (totalStrideDelegations > 0) {
          return [(r.strideDelegationNum || 0) / totalStrideDelegations];
        }
        return [null];
      });

      // New Weight:
      // - For non-flagship chains, apply capped proportional allocation with a dynamic cap:
      //     Variant B: cap(N) = max( 8% * (32/N)^0.5, 1/N )
      // - For flagship chains, New Weight is left blank here and computed later
      //   in applyFlagshipEligibilityForActiveSheet.
      const perRowNewWeights = new Array(rows.length).fill(null);

      if (!isFlagship) {
        const eligibleIndices = [];
        const eligibleStakes = [];

        rows.forEach((r, idx) => {
          if (r.finalEligible && r.deltaNoStride > 0) {
            eligibleIndices.push(idx);
            eligibleStakes.push(r.deltaNoStride);
          }
        });

        if (eligibleIndices.length > 0) {
          const capFraction = computeDynamicCapFraction(eligibleIndices.length);
          const weights = computeCappedWeights(eligibleStakes, capFraction);

          for (let k = 0; k < eligibleIndices.length; k++) {
            perRowNewWeights[eligibleIndices[k]] = weights[k];
          }
        }
      }

      const newWeightValues = perRowNewWeights.map((w) => [w]);

      sheet
        .getRange(2, COL_CURRENT_WEIGHT, numRows, 1)
        .setValues(currentWeightValues);
      sheet
        .getRange(2, COL_NEW_WEIGHT, numRows, 1)
        .setValues(newWeightValues);

      lastRow = numRows + 1;

      // Format percentage columns
      sheet
        .getRange(2, COL_COMMISSION, numRows, 1)
        .setNumberFormat('0.00%'); // Commission
      sheet
        .getRange(2, COL_CURRENT_WEIGHT, numRows, 1)
        .setNumberFormat('0.00%');
      sheet
        .getRange(2, COL_NEW_WEIGHT, numRows, 1)
        .setNumberFormat('0.00%');

      // Create filter over used range
      sheet.getRange(1, 1, lastRow, lastColumn).createFilter();
    } else {
      lastRow = 1;
      sheet.getRange(1, 1, lastRow, lastColumn).createFilter();
    }

    // Apply Verdana, size 8 to used range
    sheet
      .getRange(1, 1, lastRow, lastColumn)
      .setFontFamily('Verdana')
      .setFontSize(8);

    // Alternating row colors from Row 2 downward
    applyAlternatingRowColors(sheet, lastRow, lastColumn);

    // Fixed column widths
    sheet.setColumnWidth(COL_NAME, 300);            // A: Validator Name
    sheet.setColumnWidth(COL_ADDRESS, 400);         // B: Validator Address
    sheet.setColumnWidth(COL_STRIDE, 250);          // C: Stride Delegations
    sheet.setColumnWidth(COL_LIVE, 250);            // D: Live Delegations
    sheet.setColumnWidth(COL_DELTA, 250);           // E: Delegations Minus Stride
    sheet.setColumnWidth(COL_COMMISSION, 100);      // F: Commission
    sheet.setColumnWidth(COL_CEX, 80);              // G: CEX
    sheet.setColumnWidth(COL_ACTIVE, 80);           // H: Active
    sheet.setColumnWidth(COL_UPTIME, 100);          // I: Uptime
    sheet.setColumnWidth(COL_GOV, 110);             // J: Governance
    sheet.setColumnWidth(COL_ELIG, 90);             // K: Eligibility
    sheet.setColumnWidth(COL_REASON, 260);          // L: Reason
    sheet.setColumnWidth(COL_CURRENT_WEIGHT, 120);  // M: Current Weight
    sheet.setColumnWidth(COL_NEW_WEIGHT, 120);      // N: New Weight

    // Remove all completely blank trailing rows/columns
    trimSheetToData(sheet, lastRow, lastColumn);
  });
}

// -----------------------------------------------------------------------------
// Flagship eligibility (gov + uptime + 32-cap + weights)
// -----------------------------------------------------------------------------

/**
 * Applies full flagship eligibility to the active sheet (must be one of
 * cosmoshub-4, osmosis-1, celestia, dydx-mainnet-1).
 *
 * Uses:
 *   - Universal criteria (recomputed from sheet)
 *   - Uptime (>= 95%)
 *   - Governance:
 *       Cosmos/Osmosis/dYdX:  5/10 of recent proposals
 *       Celestia:             2/5 of recent proposals
 *   - 32-validator cap among those that pass the above.
 *
 * Also recomputes:
 *   - Current Weight (based on Stride delegations)
 *   - New Weight (based on eligible stake excluding Stride, with dynamic cap)
 *
 * Writes final Y/N to Eligibility and detailed reasons to Reason.
 */
function applyFlagshipEligibilityForActiveSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();
  const sheetName = sheet.getName();

  // Only apply on flagship sheets (chain IDs are used as sheet names)
  if (FLAGSHIP_CHAIN_IDS.indexOf(sheetName) === -1) {
    SpreadsheetApp.getUi().alert(
      'This sheet is not one of the flagship host zones (Cosmos, Osmosis, Celestia, dYdX). No flagship eligibility applied.'
    );
    return;
  }

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow <= 1) {
    SpreadsheetApp.getUi().alert('No data rows found on this sheet.');
    return;
  }

  const numRows = lastRow - 1;

  // --- Find columns by header text ---
  const headerRow = sheet
    .getRange(1, 1, 1, lastCol)
    .getValues()[0]
    .map((h) => String(h || '').trim());

  function findCol(headerName) {
    const idx = headerRow.findIndex((h) => h === headerName);
    if (idx === -1) {
      throw new Error(
        "Header '" + headerName + "' not found on sheet '" + sheetName + "'"
      );
    }
    return idx + 1; // 1-based
  }

  const colName          = findCol('Validator Name');
  const colAddr          = findCol('Validator Address');
  const colDelta         = findCol('Delegations Minus Stride');
  const colCommission    = findCol('Commission');
  const colCex           = findCol('CEX');
  const colActive        = findCol('Active');
  const colUptime        = findCol('Uptime');
  const colGov           = findCol('Governance');
  const colStride        = findCol('Stride Delegations');
  const colEligibility   = findCol('Eligibility');
  const colReason        = findCol('Reason');
  const colCurrentWeight = findCol('Current Weight');
  const colNewWeight     = findCol('New Weight');

  // --- Read data ranges ---
  const nameValues   = sheet.getRange(2, colName, numRows, 1).getValues();
  const addrValues   = sheet.getRange(2, colAddr, numRows, 1).getValues();
  const deltaValues  = sheet.getRange(2, colDelta, numRows, 1).getValues();
  const commValues   = sheet.getRange(2, colCommission, numRows, 1).getValues();
  const cexValues    = sheet.getRange(2, colCex, numRows, 1).getValues();
  const activeValues = sheet.getRange(2, colActive, numRows, 1).getValues();
  const uptimeValues = sheet.getRange(2, colUptime, numRows, 1).getValues();
  const govValues    = sheet.getRange(2, colGov, numRows, 1).getValues();
  const strideValues = sheet.getRange(2, colStride, numRows, 1).getValues();

  // --- helper parsers ---

  function parsePercentOrFraction(val) {
    if (val === '' || val == null) return 0;
    if (typeof val === 'number') {
      const n = val;
      if (isNaN(n)) return 0;
      if (n >= 0 && n <= 1.5) return n;  // already fraction (01)
      return n / 100.0;                  // 95 -> 0.95
    }
    const s = String(val).replace('%', '').trim();
    const n = parseFloat(s);
    if (isNaN(n)) return 0;
    if (n >= 0 && n <= 1.5) return n;
    return n / 100.0;
  }

  function parseCommission(val) {
    if (val === '' || val == null) return null;
    if (typeof val === 'number') {
      const n = val;
      if (isNaN(n)) return null;
      if (n <= 1.5) return n;   // decimal 01
      return n / 100.0;         // 5 -> 0.05
    }
    const s = String(val).replace('%', '').trim();
    const n = parseFloat(s);
    if (isNaN(n)) return null;
    if (n <= 1.5) return n;
    return n / 100.0;
  }

  // Governance parser: cope with "9/10", "3/5", "=9/10", 0.9, 9, "#N/A", or large date-like ints
  function parseGovFraction(val, isCelestia) {
    const defaultDenom = isCelestia ? 5 : 10;

    if (val === '' || val == null) return 0;

    // Handle numeric cases: decimals, small integers, or bad large numbers
    if (typeof val === 'number') {
      const n = val;
      if (isNaN(n)) return 0;

      // If it's clearly a fraction decimal (01.5), use as-is
      if (n >= 0 && n <= 1.5) {
        return n;
      }

      // If it's a small integer vote count (1..defaultDenom), treat as count/denom
      if (n > 0 && n <= defaultDenom) {
        return n / defaultDenom;
      }

      // Large numbers (e.g. 45910 from dates)  treat as unknown / 0
      return 0;
    }

    // From here on, treat it as text
    const s = String(val).trim();
    if (!/\d/.test(s)) return 0;

    // Prefer "x/y" style if present
    const slashMatch = s.match(/(\d+)\s*\/\s*(\d+)/);
    if (slashMatch) {
      const num = parseInt(slashMatch[1], 10);
      const denom = parseInt(slashMatch[2], 10);
      if (!isNaN(num) && !isNaN(denom) && denom > 0) {
        return num / denom;
      }
    }

    // Fallback: just grab a number and divide by default denom
    const numMatch = s.match(/(\d+)/);
    if (!numMatch) return 0;
    const num = parseInt(numMatch[1], 10);
    if (isNaN(num)) return 0;
    return num / defaultDenom;
  }

  const isCelestia = sheetName === 'celestia';
  const requiredGovFraction = isCelestia ? 2 / 5 : 5 / 10; // 0.4 or 0.5
  const maxCommission = maxCommissionForChainId(sheetName);

  // --- Build row objects from sheet data ---
  const rows = [];
  for (let i = 0; i < numRows; i++) {
    const name = String(nameValues[i][0] || '').trim();
    const addr = String(addrValues[i][0] || '').trim();

    // Delegations Minus Stride (stake excluding Stride)
    let tokens = 0;
    const deltaRaw = deltaValues[i][0];
    if (deltaRaw !== '' && deltaRaw != null) {
      const n = parseFloat(deltaRaw);
      tokens = isNaN(n) ? 0 : n;
    }

    // Stride delegations
    let strideDelegationNum = 0;
    const strideRaw = strideValues[i][0];
    if (strideRaw !== '' && strideRaw != null) {
      const n = parseFloat(strideRaw);
      strideDelegationNum = isNaN(n) ? 0 : n;
    }

    const commissionRate = parseCommission(commValues[i][0]);

    const cexFlag = String(cexValues[i][0] || '').trim().toUpperCase();
    const isCex = cexFlag === 'Y';

    const activeFlag = String(activeValues[i][0] || '').trim().toUpperCase();
    const isActive = activeFlag === 'Y';

    const uptime = parsePercentOrFraction(uptimeValues[i][0]);
    const govFraction = parseGovFraction(govValues[i][0], isCelestia);

    const isPoaPartner = isPoaPartnerMoniker(name);
    const nameExclusion = excludedNameMatch(name);

    rows.push({
      sheetRowIndex: i + 2,
      name,
      addr,
      tokens,
      strideDelegationNum,
      commissionRate,
      isCex,
      isActive,
      uptime,
      govFraction,
      isPoaPartner,
      nameExclusion,
      // Force-included if a bonded PoA partner (bypasses commission / stake rank /
      // gov / uptime; bonded status is still required). A "winding down / do not
      // delegate" moniker overrides force-inclusion.
      forceInclude: isPoaPartner && isActive && !nameExclusion,
      universalEligible: false,
      passesUptime: false,
      passesGov: false,
      baseEligible: false,
      finalEligible: false,
      reasons: [],
    });
  }

  // --- Recompute stake-based top/bottom exclusions from sheet data ---

  const activeStakeRows = rows.filter((r) => r.isActive);
  const nActive = activeStakeRows.length;

  const bottomSet = new Set();
  const topSet = new Set();

  if (nActive > 0) {
    // Bottom 5% by tokens
    const sortedAsc = activeStakeRows.slice().sort((a, b) => a.tokens - b.tokens);
    const bottomCount = Math.floor(nActive * 0.05);
    for (let i = 0; i < bottomCount; i++) {
      if (sortedAsc[i] && sortedAsc[i].addr) {
        bottomSet.add(sortedAsc[i].addr);
      }
    }

    // Top N by tokens
    const sortedDesc = activeStakeRows.slice().sort((a, b) => b.tokens - a.tokens);
    let topN = 0;
    if (nActive >= 132) {
      topN = 16;
    } else if (nActive >= 98) {
      topN = 12;
    } else if (nActive >= 64) {
      topN = 8;
    }
    for (let i = 0; i < topN; i++) {
      if (sortedDesc[i] && sortedDesc[i].addr) {
        topSet.add(sortedDesc[i].addr);
      }
    }
  }

  // --- First pass: universal + gov + uptime (base eligibility) ---

  for (const r of rows) {
    const reasons = [];

    let universalEligible = true;

    if (!r.isActive) {
      universalEligible = false;
      reasons.push('inactive');
    }
    if (r.isCex) {
      universalEligible = false;
      reasons.push('CEX');
    }

    if (r.commissionRate == null || isNaN(r.commissionRate)) {
      universalEligible = false;
      reasons.push('no_commission');
    } else if (r.commissionRate > maxCommission + 1e-9) {
      universalEligible = false;
      reasons.push('commission>' + Math.round(maxCommission * 100) + '%');
    }

    if (bottomSet.has(r.addr)) {
      universalEligible = false;
      reasons.push('bottom_5%_stake');
    }
    if (topSet.has(r.addr)) {
      universalEligible = false;
      reasons.push('top_N_stake');
    }

    if (r.nameExclusion) {
      universalEligible = false;
      reasons.push('name_excluded (' + r.nameExclusion + ')');
    }

    const passesUptime = r.uptime >= 0.95;
    const passesGov = r.govFraction >= requiredGovFraction;

    if (!passesUptime) {
      reasons.push('uptime<95% (u=' + r.uptime.toFixed(3) + ')');
    }
    if (!passesGov) {
      reasons.push(
        'gov<' +
          (isCelestia ? '2/5' : '5/10') +
          ' (fraction=' +
          r.govFraction.toFixed(3) +
          ')'
      );
    }

    r.universalEligible = universalEligible;
    r.passesUptime = passesUptime;
    r.passesGov = passesGov;

    if (r.forceInclude) {
      // Bonded PoA partner: always base-eligible, ineligibility reasons cleared.
      r.baseEligible = true;
      r.reasons = [];
    } else {
      r.baseEligible = universalEligible && passesUptime && passesGov;
      r.reasons = reasons;
    }
  }

  // --- Second pass: 32-validator global cap among baseEligible ---
  //
  // Forced PoA partners always occupy a slot and count *within* the 32. The
  // remaining slots are filled by the top regular base-eligible validators by
  // stake (Delegations Minus Stride).

  const forced = rows.filter((r) => r.forceInclude);
  const slotsForRegular = Math.max(0, 32 - forced.length);

  const regularBaseRows = rows.filter((r) => r.baseEligible && !r.forceInclude);
  regularBaseRows.sort((a, b) => b.tokens - a.tokens);

  const allowedSet = new Set(
    regularBaseRows.slice(0, slotsForRegular).map((r) => r.addr)
  );

  for (const r of rows) {
    if (r.forceInclude) {
      r.finalEligible = true;
    } else if (r.baseEligible && allowedSet.has(r.addr)) {
      r.finalEligible = true;
    } else if (r.baseEligible) {
      r.finalEligible = false;
      r.reasons.push('over_32_cap');
    } else {
      r.finalEligible = false;
    }
  }

  // --- Weights: Current Weight + New Weight (with dynamic cap) ---

  const totalStrideDelegations = rows.reduce(
    (sum, r) => sum + (r.strideDelegationNum || 0),
    0
  );

  const currentWeightValues = [];

  for (const r of rows) {
    let cw = null;
    if (totalStrideDelegations > 0) {
      cw = (r.strideDelegationNum || 0) / totalStrideDelegations;
    }
    currentWeightValues.push([cw]);
  }

  // New Weight for flagship chains:
  // Use capped proportional allocation over finalEligible validators
  // with dynamic cap computed via Variant B.

  const eligibleIndices = [];
  const eligibleStakes = [];

  rows.forEach((r, idx) => {
    if (r.finalEligible && (r.tokens || 0) > 0) {
      eligibleIndices.push(idx);
      eligibleStakes.push(r.tokens || 0); // tokens = Delegations Minus Stride
    }
  });

  const perRowNewWeights = new Array(rows.length).fill(null);

  if (eligibleIndices.length > 0) {
    const capFraction = computeDynamicCapFraction(eligibleIndices.length);
    const weights = computeCappedWeights(eligibleStakes, capFraction);

    for (let k = 0; k < eligibleIndices.length; k++) {
      perRowNewWeights[eligibleIndices[k]] = weights[k];
    }
  }

  const newWeightValues = perRowNewWeights.map((w) => [w]);

  // --- Write back Eligibility + Reason + Weights ---

  const newEligValues = [];
  const reasonValues = [];
  let eligibleCount = 0;

  for (const r of rows) {
    if (r.finalEligible) {
      eligibleCount++;
      newEligValues.push(['Y']);
      reasonValues.push([r.forceInclude ? 'force_included (PoA partner)' : 'OK']);
    } else {
      newEligValues.push(['N']);
      reasonValues.push([r.reasons.join(', ') || 'ineligible_unknown']);
    }
  }

  sheet.getRange(2, colEligibility, numRows, 1).setValues(newEligValues);
  sheet.getRange(2, colReason, numRows, 1).setValues(reasonValues);

  sheet
    .getRange(2, colCurrentWeight, numRows, 1)
    .setValues(currentWeightValues);
  sheet
    .getRange(2, colNewWeight, numRows, 1)
    .setValues(newWeightValues);

  sheet
    .getRange(2, colCurrentWeight, numRows, 1)
    .setNumberFormat('0.00%');
  sheet
    .getRange(2, colNewWeight, numRows, 1)
    .setNumberFormat('0.00%');

  SpreadsheetApp.getUi().alert(
    'Flagship eligibility applied on sheet "' +
      sheetName +
      '". Eligible validators (after 32-cap): ' +
      eligibleCount +
      ' (Eligibility, Reason, and Weight columns updated).'
  );
}

// -----------------------------------------------------------------------------
// Live validator fetch (cosmos.directory)
// -----------------------------------------------------------------------------

function fetchLiveValidatorsForHostZone(hz) {
  const chainId = hz.chain_id || '';
  const network = CHAIN_ID_TO_NETWORK[chainId];

  if (!network) {
    Logger.log(
      'No cosmos.directory mapping for chain_id ' +
        chainId +
        '  live data skipped.'
    );
    return [];
  }

  const liveUrl =
    'https://rest.cosmos.directory/' +
    network +
    '/cosmos/staking/v1beta1/validators?pagination.limit=1000';

  try {
    const response = UrlFetchApp.fetch(liveUrl, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) {
      Logger.log(
        'HTTP ' +
          response.getResponseCode() +
          ' for network ' +
          network +
          ' at ' +
          liveUrl
      );
      return [];
    }
    const data = JSON.parse(response.getContentText());
    return data.validators || [];
  } catch (e) {
    Logger.log('Error fetching validators for ' + network + ': ' + e);
    return [];
  }
}

// -----------------------------------------------------------------------------
// CEX detection
// -----------------------------------------------------------------------------

function isCexMoniker(name) {
  if (!name) return false;
  const s = String(name).toLowerCase();

  const patterns = [
    'binance',
    'coinbase',
    'kraken',
    'okx',
    'kucoin',
    'huobi',
    'coinone',
    'upbit',
    'cex.io',
    'bitrue',
    'bigone-pool',
    'blofin',
    'bitcoinsuisse.com',
    'bity.com',
    'mycointainer',
  ];

  return patterns.some((p) => s.indexOf(p.toLowerCase()) !== -1);
}

/**
 * True if the moniker belongs to one of Stride's proof-of-authority partner
 * validators (see POA_PARTNER_PATTERNS). Case-insensitive substring match.
 */
function isPoaPartnerMoniker(name) {
  if (!name) return false;
  const s = String(name).toLowerCase();
  return POA_PARTNER_PATTERNS.some((p) => s.indexOf(p) !== -1);
}

/**
 * If the moniker contains a "winding down / do not delegate" signal
 * (see EXCLUDED_NAME_PATTERNS), returns the matched pattern; otherwise null.
 * Case-insensitive; collapses runs of whitespace so e.g. "shutting   down"
 * still matches "shutting down".
 */
function excludedNameMatch(name) {
  if (!name) return null;
  const s = String(name).toLowerCase().replace(/\s+/g, ' ');
  for (let i = 0; i < EXCLUDED_NAME_PATTERNS.length; i++) {
    if (s.indexOf(EXCLUDED_NAME_PATTERNS[i]) !== -1) {
      return EXCLUDED_NAME_PATTERNS[i];
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Merge Stride + live validator sets
// -----------------------------------------------------------------------------

/**
 * Combine Stride host_zone validators and live chain validators
 * into a consistent row structure.
 *
 * Returns array of objects:
 * {
 *   name,
 *   address,
 *   strideDelegationStr,
 *   liveTokensStr,
 *   strideDelegationNum,
 *   liveTokensNum,
 *   deltaNoStride,
 *   status,
 *   isCex,
 *   commissionRate    // decimal, e.g. 0.05 for 5%
 * }
 */
function buildMergedValidatorRows(strideValidators, liveValidators) {
  const rows = [];

  // Map of Stride validators by operator address
  const strideByAddr = {};
  (strideValidators || []).forEach((v) => {
    if (v.address) {
      strideByAddr[v.address] = v;
    }
  });

  const seenAddr = {};

  // First, use the full live set as primary
  (liveValidators || []).forEach((v) => {
    const addr = v.operator_address || '';
    if (!addr) return;

    const strideV = strideByAddr[addr];

    const strideDelegationStr = strideV ? String(strideV.delegation || '0') : '0';
    const tokensStr = String(v.tokens || '0');

    const strideDelegationNum = Number(strideDelegationStr) || 0;
    const liveTokensNum = Number(tokensStr) || 0;
    const deltaNoStride = liveTokensNum - strideDelegationNum;

    let moniker =
      (v.description && v.description.moniker) ||
      (strideV && strideV.name) ||
      addr;
    moniker = String(moniker).trim(); // trim leading/trailing spaces

    const status = v.status || '';

    // Commission: try commission.commission_rates.rate, fallback to commission.rate
    let commissionRate = null;
    if (v.commission) {
      const cr = v.commission.commission_rates || v.commission;
      if (cr && typeof cr.rate !== 'undefined') {
        const rNum = Number(cr.rate);
        if (!isNaN(rNum)) {
          commissionRate = rNum;
        }
      }
    }

    const isCex = isCexMoniker(moniker);
    const isPoaPartner = isPoaPartnerMoniker(moniker);
    const nameExclusion = excludedNameMatch(moniker);

    rows.push({
      name: moniker,
      address: addr,
      strideDelegationStr,
      liveTokensStr: tokensStr,
      strideDelegationNum,
      liveTokensNum,
      deltaNoStride,
      status,
      isCex,
      isPoaPartner,
      nameExclusion,
      commissionRate,
      universalEligible: false,
      forceInclude: false,
      finalEligible: false,
      reasons: [],
    });

    seenAddr[addr] = true;
  });

  // Add any Stride validators not in the live set (edge case)
  (strideValidators || []).forEach((v) => {
    const addr = v.address || '';
    if (!addr || seenAddr[addr]) return;

    const strideDelegationStr = String(v.delegation || '0');
    const tokensStr = '0';

    const strideDelegationNum = Number(strideDelegationStr) || 0;
    const liveTokensNum = 0;
    const deltaNoStride = liveTokensNum - strideDelegationNum;

    let moniker = v.name || addr;
    moniker = String(moniker).trim();

    const status = ''; // no live info

    const isCex = isCexMoniker(moniker);
    const isPoaPartner = isPoaPartnerMoniker(moniker);
    const nameExclusion = excludedNameMatch(moniker);

    rows.push({
      name: moniker,
      address: addr,
      strideDelegationStr,
      liveTokensStr: tokensStr,
      strideDelegationNum,
      liveTokensNum,
      deltaNoStride,
      status,
      isCex,
      isPoaPartner,
      nameExclusion,
      commissionRate: null,
      universalEligible: false,
      forceInclude: false,
      finalEligible: false,
      reasons: [],
    });
  });

  return rows;
}

// -----------------------------------------------------------------------------
// Formatting helpers
// -----------------------------------------------------------------------------

function applyAlternatingRowColors(sheet, lastRow, lastColumn) {
  if (lastRow <= 1) return;

  const numRows = lastRow - 1; // rows 2..lastRow
  const color1 = '#ffffff';
  const color2 = '#f5f5f5';

  const backgrounds = [];
  for (let i = 0; i < numRows; i++) {
    const rowColor = i % 2 === 0 ? color1 : color2;
    const row = [];
    for (let j = 0; j < lastColumn; j++) {
      row.push(rowColor);
    }
    backgrounds.push(row);
  }

  sheet.getRange(2, 1, numRows, lastColumn).setBackgrounds(backgrounds);
}

/**
 * Delete trailing blank rows and columns so the sheet only
 * has up to lastRow x lastColumn, but always keeps at least
 * one non-frozen row (to avoid "delete all non-frozen rows" error).
 */
function trimSheetToData(sheet, lastRow, lastColumn) {
  const maxRows = sheet.getMaxRows();
  const frozenRows = sheet.getFrozenRows(); // typically 1

  // Google Sheets requires at least one non-frozen row.
  const minRowsToKeep = Math.max(lastRow, frozenRows + 1);

  if (maxRows > minRowsToKeep) {
    const rowsToDelete = maxRows - minRowsToKeep;
    if (rowsToDelete > 0) {
      sheet.deleteRows(minRowsToKeep + 1, rowsToDelete);
    }
  }

  // Trim columns
  const maxCols = sheet.getMaxColumns();
  if (lastColumn < maxCols) {
    sheet.deleteColumns(lastColumn + 1, maxCols - lastColumn);
  }
}

/**
 * Sanitize sheet names to avoid invalid characters and length limits.
 */
function sanitizeSheetName(name) {
  if (!name) name = 'host_zone';
  name = String(name);

  // Sheets can't use these characters: [ ] * ? : / \
  name = name.replace(/[\[\]\*\/\\\?\:]/g, '_');

  // Sheet name limit: 100 characters
  if (name.length > 99) {
    name = name.slice(0, 99);
  }

  return name;
}

