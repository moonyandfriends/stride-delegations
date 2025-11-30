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
  'comdex-1': 'comdex',
  'evmos_9001-2': 'evmos',
  'injective-1': 'injective',
  'haqq_11235-1': 'haqq',
  'juno-1': 'juno',

  // Bandchain – keep only laozi-mainnet
  'laozi-mainnet': 'bandchain',

  'osmosis-1': 'osmosis',
  'phoenix-1': 'terra2',
  'sommelier-3': 'sommelier',

  // Saga – support both possible chain IDs
  'saga-1': 'saga',
  'ssc-1': 'saga',

  'stargaze-1': 'stargaze',
  'umee-1': 'umee',
};

// Column indices (1-based)
const COL_NAME            = 1;  // A: Validator Name
const COL_ADDRESS         = 2;  // B: Validator Address
const COL_STRIDE          = 3;  // C: Stride Delegations
const COL_LIVE            = 4;  // D: Live Delegations
const COL_DELTA           = 5;  // E: Delegations Minus Stride
const COL_COMMISSION      = 6;  // F: Commission
const COL_CEX             = 7;  // G: CEX
const COL_ACTIVE          = 8;  // H: Active
const COL_UPTIME          = 9;  // I: Uptime (manual / VLOOKUP)
const COL_GOV             = 10; // J: Governance (manual / VLOOKUP)
const COL_ELIG            = 11; // K: Eligibility
const COL_REASON          = 12; // L: Reason
const COL_CURRENT_WEIGHT  = 13; // M: Current Weight
const COL_NEW_WEIGHT      = 14; // N: New Weight

const LAST_COLUMN = COL_NEW_WEIGHT;

// Max share per validator for New Weight
const NEW_WEIGHT_CAP = 0.09;   // 9%
// Minimum positive-stake eligible validators before we enforce the cap
const MIN_COUNT_FOR_CAP = 12;

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
 *       64+ validators → exclude top 8 by stake (excl. Stride)
 *       98+ validators → exclude top 12
 *       132+ validators → exclude top 16
 *
 *  Then apply a 32-validator cap per chain:
 *  - Among validators that pass universal criteria, sort by Delegations Minus Stride
 *    (stake excluding Stride) descending, and only the top 32 remain finally eligible.
 *
 * For flagship chains, we only compute universal + reasons here; final eligibility
 * (gov + uptime + 32-cap) and New Weight are applied later via the menu.
 *
 * New Weight:
 *  - For non-flagship chains: capped proportional ("water-filling") with 9% cap
 *    over finalEligible validators, provided there are at least MIN_COUNT_FOR_CAP
 *    positive-stake eligible validators; otherwise simple proportional.
 *  - For flagship chains: computed later in applyFlagshipEligibilityForActiveSheet.
 */
function createStrideSheetsWithLiveData(ss, hostZones) {
  hostZones.forEach((hz) => {
    const chainId = hz.chain_id || '';
    const rawName = chainId || hz.host_denom || 'host_zone';
    const sheetName = sanitizeSheetName(rawName);
    const isFlagship = FLAGSHIP_CHAIN_IDS.indexOf(chainId) !== -1;

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
      } else if (r.commissionRate > 0.10) {
        universalEligible = false;
        reasons.push('commission>10%');
      }

      if (bottomSet.has(r.address)) {
        universalEligible = false;
        reasons.push('bottom_5%_stake');
      }

      if (topSet.has(r.address)) {
        universalEligible = false;
        reasons.push('top_N_stake');
      }

      r.universalEligible = universalEligible;
      r.reasons = reasons; // may be empty
      r.finalEligible = false; // filled below for non-flagship
    });

    // --- 32-validator global cap (non-flagship only at this stage) ---

    if (!isFlagship) {
      const baseEligible = rows.filter((r) => r.universalEligible);
      if (baseEligible.length > 0) {
        if (baseEligible.length > 32) {
          baseEligible.sort((a, b) => b.deltaNoStride - a.deltaNoStride);
          const allowedSet = new Set(
            baseEligible.slice(0, 32).map((r) => r.address)
          );

          rows.forEach((r) => {
            if (r.universalEligible && allowedSet.has(r.address)) {
              r.finalEligible = true;
            } else if (r.universalEligible && !allowedSet.has(r.address)) {
              r.finalEligible = false;
              r.reasons.push('over_32_cap');
            } else {
              r.finalEligible = false;
            }
          });
        } else {
          // ≤ 32: finalEligible = universalEligible
          rows.forEach((r) => {
            r.finalEligible = r.universalEligible;
          });
        }
      }
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
        reasonValues = rows.map((r) => [
          r.universalEligible
            ? 'universal_OK (run flagship eligibility tool)'
            : (r.reasons.join(', ') || 'ineligible_unknown'),
        ]);
      } else {
        eligibilityValues = rows.map((r) => [r.finalEligible ? 'Y' : 'N']);
        reasonValues = rows.map((r) => [
          r.finalEligible ? 'OK' : (r.reasons.join(', ') || 'ineligible_unknown'),
        ]);
      }

      sheet.getRange(2, COL_ELIG, numRows, 1).setValues(eligibilityValues);
      sheet.getRange(2, COL_REASON, numRows, 1).setValues(reasonValues);

      // --- Current Weight + New Weight (non-flagship) ---

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
      // - Non-flagship: capped proportional (water-filling) over finalEligible rows.
      // - Flagship: left blank here; computed later in applyFlagshipEligibilityForActiveSheet.
      let newWeightValues;

      if (!isFlagship) {
        const eligibleRows = rows.filter(
          (r) => r.finalEligible && r.deltaNoStride > 0
        );
        const stakes = eligibleRows.map((r) => r.deltaNoStride);
        const weights = computeCappedProportionalWeights(
          stakes,
          NEW_WEIGHT_CAP,
          MIN_COUNT_FOR_CAP
        );

        const weightByAddr = {};
        eligibleRows.forEach((r, idx) => {
          weightByAddr[r.address] = weights[idx];
        });

        newWeightValues = rows.map((r) => {
          if (r.finalEligible && weightByAddr.hasOwnProperty(r.address)) {
            return [weightByAddr[r.address]];
          }
          return [null];
        });
      } else {
        // Flagship chains: New Weight set in applyFlagshipEligibilityForActiveSheet.
        newWeightValues = rows.map(() => [null]);
      }

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
// Flagship eligibility (gov + uptime + 32-cap + capped weights)
// -----------------------------------------------------------------------------

/**
 * Applies full flagship eligibility to the active sheet (must be one of
 * cosmoshub-4, osmosis-1, celestia, dydx-mainnet-1).
 *
 * Uses:
 *   - Universal criteria (recomputed from sheet)
 *   - Uptime (>= 95%)
 *   - Governance:
 *       Cosmos/Osmosis/dYdX: ≥ 5/10 of recent proposals (fraction ≥ 0.5)
 *       Celestia:            ≥ 2/5 of recent proposals (fraction ≥ 0.4)
 *   - 32-validator cap among those that pass the above.
 *
 * Also recomputes:
 *   - Current Weight (based on Stride delegations)
 *   - New Weight (capped proportional with 9% cap when enough validators)
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
      if (n <= 1.5) return n;   // already 0–1
      return n / 100.0;         // 95 -> 0.95
    }
    const s = String(val).replace('%', '').trim();
    const n = parseFloat(s);
    if (isNaN(n)) return 0;
    if (n <= 1.5) return n;
    return n / 100.0;
  }

  // Governance parser: cope with "9/10", "3/5", "=9/10", 0.9, 9, "#N/A", and
  // also ignore large numeric date-serials like 45910 by treating them as 0.
  function parseGovFraction(val, isCelestia) {
    const defaultDenom = isCelestia ? 5 : 10;

    if (val === '' || val == null) return 0;

    if (typeof val === 'number') {
      const n = val;
      if (isNaN(n)) return 0;

      // Already a fraction (e.g. 0.8)
      if (n >= 0 && n <= 1.5) {
        return n;
      }

      // Small integer vote count (1..denom)
      if (n > 0 && n <= defaultDenom) {
        return n / defaultDenom;
      }

      // Large numbers (e.g. date serials 45910) -> treat as "no data"
      return 0;
    }

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

  // --- Build row objects from sheet data ---
  const rows = [];
  for (let i = 0; i < numRows; i++) {
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

    const commissionRate = (function (val) {
      if (val === '' || val == null) return null;
      if (typeof val === 'number') {
        const n = val;
        if (isNaN(n)) return null;
        if (n <= 1.5) return n;
        return n / 100.0;
      }
      const s = String(val).replace('%', '').trim();
      const n = parseFloat(s);
      if (isNaN(n)) return null;
      if (n <= 1.5) return n;
      return n / 100.0;
    })(commValues[i][0]);

    const cexFlag = String(cexValues[i][0] || '').trim().toUpperCase();
    const isCex = cexFlag === 'Y';

    const activeFlag = String(activeValues[i][0] || '').trim().toUpperCase();
    const isActive = activeFlag === 'Y';

    const uptime = parsePercentOrFraction(uptimeValues[i][0]);
    const govFraction = parseGovFraction(govValues[i][0], isCelestia);

    rows.push({
      sheetRowIndex: i + 2,
      addr,
      tokens,
      strideDelegationNum,
      commissionRate,
      isCex,
      isActive,
      uptime,
      govFraction,
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
    } else if (r.commissionRate > 0.10) {
      universalEligible = false;
      reasons.push('commission>10%');
    }

    if (bottomSet.has(r.addr)) {
      universalEligible = false;
      reasons.push('bottom_5%_stake');
    }
    if (topSet.has(r.addr)) {
      universalEligible = false;
      reasons.push('top_N_stake');
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
    r.baseEligible = universalEligible && passesUptime && passesGov;
    r.reasons = reasons;
  }

  // --- Second pass: 32-validator global cap among baseEligible ---

  const baseEligibleRows = rows.filter((r) => r.baseEligible);
  if (baseEligibleRows.length > 0) {
    // Sort by tokens (Delegations Minus Stride) descending
    baseEligibleRows.sort((a, b) => b.tokens - a.tokens);

    const allowed = baseEligibleRows.slice(0, 32).map((r) => r.addr);
    const allowedSet = new Set(allowed);

    for (const r of rows) {
      if (r.baseEligible && allowedSet.has(r.addr)) {
        r.finalEligible = true;
      } else if (r.baseEligible && !allowedSet.has(r.addr)) {
        r.finalEligible = false;
        r.reasons.push('over_32_cap');
      } else {
        r.finalEligible = false;
      }
    }
  } else {
    // Nobody passes base criteria
    for (const r of rows) {
      r.finalEligible = false;
    }
  }

  // --- Weights: Current Weight + New Weight (capped) ---

  const totalStrideDelegations = rows.reduce(
    (sum, r) => sum + (r.strideDelegationNum || 0),
    0
  );

  const currentWeightValues = [];

  // Current Weight: simple share of Stride delegations
  for (const r of rows) {
    let cw = null;
    if (totalStrideDelegations > 0) {
      cw = (r.strideDelegationNum || 0) / totalStrideDelegations;
    }
    currentWeightValues.push([cw]);
  }

  // New Weight: capped proportional ("water-filling") over finalEligible rows
  const eligibleRows = rows.filter((r) => r.finalEligible && (r.tokens || 0) > 0);
  const stakes = eligibleRows.map((r) => r.tokens || 0);
  const weights = computeCappedProportionalWeights(
    stakes,
    NEW_WEIGHT_CAP,
    MIN_COUNT_FOR_CAP
  );

  const weightByAddr = {};
  eligibleRows.forEach((r, idx) => {
    weightByAddr[r.addr] = weights[idx];
  });

  const newWeightValues = rows.map((r) => {
    if (r.finalEligible && weightByAddr.hasOwnProperty(r.addr)) {
      return [weightByAddr[r.addr]];
    }
    return [null];
  });

  // --- Write back Eligibility + Reason + Weights ---

  const newEligValues = [];
  const reasonValues = [];
  let eligibleCount = 0;

  for (const r of rows) {
    if (r.finalEligible) {
      eligibleCount++;
      newEligValues.push(['Y']);
      reasonValues.push(['OK']);
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
      ' (Eligibility, Reason, and capped New Weight updated).'
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
        ' — live data skipped.'
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
      commissionRate,
      universalEligible: false,
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
      commissionRate: null,
      universalEligible: false,
      finalEligible: false,
      reasons: [],
    });
  });

  return rows;
}

// -----------------------------------------------------------------------------
// Capped proportional weight helper (water-filling)
// -----------------------------------------------------------------------------

/**
 * Compute capped proportional weights using a "water-filling" algorithm.
 *
 * stakes: array of non-negative numbers (e.g., stake minus Stride)
 * cap: maximum allowed weight per entry (e.g., 0.09 for 9%)
 * minCountForCap: if number of positive-stake entries is less than this,
 *                 no cap is applied (simple proportional weights).
 *
 * Returns an array of weights of same length as stakes, summing to ~1
 * (or 0 if total stake is 0), each in [0, cap] when cap is active.
 */
function computeCappedProportionalWeights(stakes, cap, minCountForCap) {
  const n = stakes.length;
  const weights = new Array(n).fill(0);

  if (n === 0) {
    return weights;
  }

  // Clean negative stakes
  const cleanedStakes = stakes.map((s) => (s > 0 ? s : 0));

  let totalStake = cleanedStakes.reduce((sum, s) => sum + s, 0);
  if (totalStake <= 0) {
    return weights;
  }

  const positiveCount = cleanedStakes.filter((s) => s > 0).length;
  if (positiveCount === 0) {
    return weights;
  }

  // If there are too few validators, don't cap; just normalize.
  if (minCountForCap && positiveCount < minCountForCap) {
    for (let i = 0; i < n; i++) {
      if (cleanedStakes[i] > 0) {
        weights[i] = cleanedStakes[i] / totalStake;
      }
    }
    return weights;
  }

  let remainingIndices = [];
  for (let i = 0; i < n; i++) {
    if (cleanedStakes[i] > 0) {
      remainingIndices.push(i);
    }
  }

  let remainingStake = remainingIndices.reduce(
    (sum, idx) => sum + cleanedStakes[idx],
    0
  );
  let remainingBudget = 1.0;

  const EPS = 1e-12;

  while (
    remainingIndices.length > 0 &&
    remainingStake > EPS &&
    remainingBudget > EPS
  ) {
    const provisional = {};
    const overCap = [];

    // Proportional allocation of remaining budget
    for (const idx of remainingIndices) {
      const w = (remainingBudget * cleanedStakes[idx]) / remainingStake;
      provisional[idx] = w;
      if (w > cap + EPS) {
        overCap.push(idx);
      }
    }

    if (overCap.length === 0) {
      // Nobody exceeds the cap -> finalize
      for (const idx of remainingIndices) {
        weights[idx] = provisional[idx];
      }
      remainingBudget = 0;
      break;
    }

    // Cap all oversubscribed validators at "cap"
    let cappedStake = 0;
    for (const idx of overCap) {
      weights[idx] = cap;
      remainingBudget -= cap;
      cappedStake += cleanedStakes[idx];
    }

    // Remove them from the remaining set
    remainingIndices = remainingIndices.filter(
      (idx) => overCap.indexOf(idx) === -1
    );
    remainingStake -= cappedStake;

    if (remainingBudget <= EPS || remainingStake <= EPS) {
      break;
    }
  }

  // If we still have positive stake and budget (should be rare), allocate proportionally
  if (remainingIndices.length > 0 && remainingBudget > EPS && remainingStake > EPS) {
    for (const idx of remainingIndices) {
      weights[idx] = (remainingBudget * cleanedStakes[idx]) / remainingStake;
    }
  }

  // Optional: small normalization to sum to 1 (when totalStake > 0)
  const sumW = weights.reduce((sum, w) => sum + w, 0);
  if (sumW > EPS) {
    const factor = 1.0 / sumW;
    for (let i = 0; i < n; i++) {
      weights[i] *= factor;
    }
  }

  return weights;
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
    sheet.deleteRows(minRowsToKeep + 1, rowsToDelete);
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

