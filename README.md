# Stride Delegations - Google Apps Script

This Google Apps Script automates the calculation and management of Stride's standardized delegation methodology across all host chains.

## Overview

This script implements Stride's unified delegation strategy, which distributes delegations according to each validator's stake weight among qualifying validators using a capped proportional ("water-filling") method. No validator receives more than 9% of Stride's stake on any chain (unless insufficient eligible validators exist).

## Live Spreadsheet

Current delegation weights can be viewed here:
https://docs.google.com/spreadsheets/d/1-CIvqQXiip-IMAf_DF3hTaVyjfWXbIBsbmCdplIvDYE/edit?usp=sharing

## Delegation Methodology

### Universal Eligibility Criteria (All Host Chains)

1. **Exclude known CEX validators**
2. **Commission rate ≤ 10%**
3. **Not in the bottom 5% of the active set by stake**¹
4. **Top validator exclusions based on active set size:**
   - 64+ validators → exclude top 8 by stake¹
   - 98+ validators → exclude top 12 by stake¹
   - 132+ validators → exclude top 16 by stake¹
5. **Limit to top 32 validators** among those meeting above criteria, ranked by stake weight¹

¹ *All stake measurements exclude Stride's current delegations to prevent circular reinforcement*

### Additional Criteria (Cosmos Hub, Osmosis, Celestia, dYdX Only)

These flagship chains with significant TVL have stricter requirements:

6. **Governance participation:** Must have voted on at least 5 of the 10 most recent proposals (or 2 of 5 if fewer than 10 total proposals exist)
7. **Uptime:** Average signing time ≥ 95% over the past 30 days

*Note: These additional criteria require off-chain data from indexers and cannot be fully automated, hence their limitation to flagship chains.*

## Distribution Method

Among all qualifying validators, delegations are distributed proportionally to each validator's stake weight using a **capped proportional (water-filling) approach**:

- Validators receive delegations proportional to their stake
- No single validator receives more than 9% of Stride's total stake on that chain
- This prevents over-concentration while maintaining proportionality

## Rebalancing Schedule

- **Quarterly rebalancing** to reflect changes in validator stake weights and eligibility
- Initial rebalancing aligned with Q1 2025
- Validators meeting criteria receive proportional delegations
- Ineligible validators have delegations reduced or removed

## Special Cases

**Dymension and Celestia (Multisig-handled):**
- Redelegations on these chains are currently managed via multisig
- Not included in automated rebalancing until moved to ICA/ICQ handling
- Stride's ICA/ICQ-handled Celestia liquid staking is fully covered

## How It Works

### Data Sources

The script combines data from multiple sources:

1. **Stride delegations:** Fetched from Polkachu API (`https://stride-api.polkachu.com/Stride-Labs/stride/stakeibc/host_zone`)
2. **Live validator data:** Fetched from cosmos.directory REST endpoints for each chain
3. **Uptime and governance data (flagship chains only):** Manually entered from https://analytics.smartstake.io

### Two-Step Process

**Step 1: Refresh host_zones + live data** (all chains)
- Menu: **Stride > Refresh host_zones + live data**
- Fetches and merges Stride delegations with live chain data
- Creates one sheet per host chain with 14 columns (A-N)
- Applies universal eligibility criteria automatically
- For non-flagship chains: computes final eligibility and delegation weights
- For flagship chains (Cosmos Hub, Osmosis, Celestia, dYdX): leaves eligibility blank until Step 2

**Step 2: Apply flagship eligibility** (flagship chains only)
- Menu: **Stride > Apply flagship eligibility (gov + uptime)**
- Must be run on each flagship chain sheet individually
- Requires uptime and governance data to be populated first (see below)
- Applies governance and uptime thresholds
- Computes final eligibility with 32-validator cap
- Calculates capped proportional weights

### Manual Data Entry for Flagship Chains

Before running Step 2 for flagship chains, create supporting sheets with data from https://analytics.smartstake.io:

**Required sheets:**
- `cosmos-uptime+governance`
- `osmosis-uptime+governance`
- `celestia-uptime+governance`
- `dydx-uptime+governance`

**Sheet format (3 columns):**
- Column A: Validator Name (must match exactly)
- Column B: Governance participation (e.g., "9/10" or "0.9")
- Column C: Uptime / Sign time (e.g., "98.5%" or "0.985")

The main chain sheets use VLOOKUP formulas to automatically pull this data into columns I (Uptime) and J (Governance).

### Sheet Structure

Each host chain sheet contains:

**Columns A-D: Basic Data**
- A: Validator Name
- B: Validator Address
- C: Stride Delegations (from Stride API)
- D: Live Delegations (from cosmos.directory)

**Column E: Calculated Stake**
- E: Delegations Minus Stride = D - C
- Used for all stake-based rankings to prevent circular reinforcement

**Columns F-H: Universal Criteria (On-Chain)**
- F: Commission (from live data)
- G: CEX (Y/N, detected from validator moniker)
- H: Active (Y/N, bonded status)

**Columns I-J: Flagship Criteria (Off-Chain)**
- I: Uptime (VLOOKUP from supporting sheets)
- J: Governance (VLOOKUP from supporting sheets)

**Columns K-L: Results**
- K: Eligibility (Y/N)
- L: Reason (OK or comma-separated list of failures)

**Columns M-N: Weights**
- M: Current Weight (current share of Stride's delegations)
- N: New Weight (capped proportional distribution)

### Eligibility Logic

**Universal criteria (applied to all chains):**
- Active status (BOND_STATUS_BONDED)
- Not a known CEX validator (pattern matching on moniker)
- Commission rate ≤ 10%
- Not in bottom 5% of active set by stake (excluding Stride's delegations)
- Not in top N by stake where N depends on active set size:
  - 64+ validators: exclude top 8
  - 98+ validators: exclude top 12
  - 132+ validators: exclude top 16
- Among remaining validators, only top 32 by stake are eligible

**Additional flagship criteria:**
- Cosmos Hub, Osmosis, dYdX: ≥5/10 governance participation
- Celestia: ≥2/5 governance participation
- All flagship chains: ≥95% uptime

### Weight Distribution Algorithm

The script uses a **capped proportional ("water-filling")** algorithm:

1. Start with all eligible validators
2. Distribute weights proportional to their stake (Delegations Minus Stride)
3. If any validator would receive >9%, cap them at 9%
4. Redistribute remaining weight to uncapped validators
5. Repeat until all validators are capped or no weight remains
6. If <12 eligible validators, skip capping and use simple proportional weights

Implemented in `computeCappedProportionalWeights()` (lines 1132-1251).

## Usage Instructions

### Initial Setup

1. Open the Google Spreadsheet
2. Go to **Extensions > Apps Script**
3. Copy code from `stride-delegations.gs` into the script editor
4. Save and authorize the script when prompted

### Regular Workflow

**For all chains:**
1. Run **Stride > Refresh host_zones + live data**
2. Wait for all sheets to be created/updated

**For flagship chains (Cosmos Hub, Osmosis, Celestia, dYdX):**
3. Visit https://analytics.smartstake.io
4. For each flagship chain, gather:
   - Governance participation data (votes on recent proposals)
   - Uptime / sign time data (30-day average)
5. Enter data into corresponding `[chain]-uptime+governance` sheets
6. Switch to the flagship chain sheet (e.g., `cosmoshub-4`)
7. Run **Stride > Apply flagship eligibility (gov + uptime)**
8. Verify that columns I, J, K, L, M, N are populated correctly
9. Repeat for each flagship chain

### Interpreting Results

- **Eligibility = Y:** Validator meets all criteria and receives delegations
- **Eligibility = N:** Check Reason column for specific failures
- **New Weight:** Proposed delegation percentage for this validator
- **Current Weight:** Existing delegation percentage

Common ineligibility reasons:
- `inactive`: Not in bonded status
- `CEX`: Known centralized exchange validator
- `commission>10%`: Commission rate exceeds threshold
- `bottom_5%_stake`: In bottom 5% by stake
- `top_N_stake`: In top N by stake (over-concentrated)
- `over_32_cap`: Outside top 32 eligible validators
- `uptime<95%`: Below 95% uptime threshold (flagship only)
- `gov<5/10` or `gov<2/5`: Insufficient governance participation (flagship only)

## Governance

This implementation follows Stride Governance Proposal [NUMBER]. Any modifications to delegation criteria or methodology require governance approval.

## Repository Structure

```
stride-delegations/
├── README.md                 # This file - user documentation
├── CLAUDE.md                 # Claude Code assistant guide
├── stride-delegations.gs     # Main Google Apps Script code
└── .gitignore               # Git ignore file
```

## Technical Details

### CEX Validator Detection

The script identifies centralized exchange validators by matching patterns in validator monikers:
- binance, coinbase, kraken, okx, kucoin, huobi, coinone, upbit, cex.io, bitrue, bigone-pool, blofin, bitcoinsuisse.com, bity.com, mycointainer

See `isCexMoniker()` function (lines 974-997).

### Chain ID to Network Mapping

Stride's `host_zone.chain_id` values are mapped to cosmos.directory network names for fetching live data. Special cases:
- Bandchain: only `laozi-mainnet` supported
- Saga: supports both `saga-1` and `ssc-1` chain IDs

See `CHAIN_ID_TO_NETWORK` constant (lines 28-51).

### API Endpoints

- **Stride data:** `https://stride-api.polkachu.com/Stride-Labs/stride/stakeibc/host_zone`
- **Live validators:** `https://rest.cosmos.directory/{network}/cosmos/staking/v1beta1/validators?pagination.limit=1000`
- **Uptime/governance:** Manual entry from https://analytics.smartstake.io (no API integration)

### Code Organization

- Lines 1-75: Constants and configuration
- Lines 77-94: Menu setup
- Lines 96-126: Main refresh entry point
- Lines 128-512: Core sheet creation with universal eligibility
- Lines 514-925: Flagship eligibility application
- Lines 927-968: Live validator data fetching
- Lines 970-997: CEX detection
- Lines 999-1126: Validator data merging
- Lines 1128-1251: Capped proportional weight algorithm
- Lines 1253-1318: Formatting and utility helpers

## Contributing

Changes to the delegation methodology must be approved through Stride governance. Technical improvements and bug fixes can be submitted via pull request.

For questions or issues, please contact Stride Labs or open an issue in this repository.
