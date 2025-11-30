# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This repository contains a Google Apps Script that automates Stride's standardized delegation methodology across all host chains. The script runs inside a Google Spreadsheet and calculates which validators should receive delegations based on on-chain data and eligibility criteria.

**Live Spreadsheet:** https://docs.google.com/spreadsheets/d/1-CIvqQXiip-IMAf_DF3hTaVyjfWXbIBsbmCdplIvDYE/edit?usp=sharing

## Key Architecture Concepts

### Two-Tier Eligibility System

The script implements different eligibility criteria based on chain type:

1. **Universal Criteria (All Chains):** Applied automatically using on-chain data
   - Active status (BOND_STATUS_BONDED)
   - Not a known CEX validator
   - Commission rate ≤ 10%
   - Not in bottom 5% by stake (excluding Stride delegations)
   - Dynamic top-validator exclusions based on active set size (64+/98+/132+ thresholds)
   - Limited to top 32 validators meeting above criteria

2. **Flagship Chain Criteria (Cosmos Hub, Osmosis, Celestia, dYdX):** Requires manual data input
   - All universal criteria PLUS
   - Governance participation (5/10 or 2/5 of recent proposals depending on chain)
   - Uptime ≥ 95% over past 30 days
   - These chains require running the "Apply flagship eligibility" menu item after data refresh

### Weight Distribution Algorithm

The script uses a **capped proportional ("water-filling")** algorithm to distribute delegation weights:

- Validators receive delegations proportional to their stake weight
- No validator gets more than 9% of Stride's total stake on that chain
- Cap only applies when there are ≥12 eligible validators with positive stake
- Implemented in `computeCappedProportionalWeights()` (lines 1132-1251)

### Data Flow

1. **Refresh host_zones + live data** (main refresh):
   - Fetches Stride's current delegations via Polkachu API (`STRIDE_API_URL`)
   - Fetches live validator data from cosmos.directory for each chain
   - Merges both datasets by validator address
   - Computes "Delegations Minus Stride" (live stake excluding Stride's delegations)
   - Applies universal eligibility criteria
   - For non-flagship chains: computes final eligibility and weights immediately
   - For flagship chains: leaves eligibility blank until manual step

2. **Apply flagship eligibility** (manual step for flagship chains):
   - Reads uptime and governance data from dedicated sheets (via VLOOKUP formulas)
   - Applies all criteria including gov/uptime thresholds
   - Computes final eligibility with 32-validator cap
   - Computes capped proportional weights

### Stake Calculation Details

**Critical:** All stake-based calculations (top/bottom exclusions, ranking) use "Delegations Minus Stride" (Column E), which is computed as:
```
Live Delegations - Stride Delegations
```

This prevents circular reinforcement where Stride's existing delegations would cause validators to rank higher, perpetuating current allocations.

### Sheet Structure

Each host chain gets its own sheet with 14 columns (A-N):

- **A-D:** Basic validator info (Name, Address, Stride Delegations, Live Delegations)
- **E:** Delegations Minus Stride (formula: =D-C)
- **F-H:** On-chain criteria (Commission, CEX flag, Active status)
- **I-J:** Off-chain criteria for flagship chains only (Uptime, Governance)
- **K-L:** Eligibility results (Y/N, reasons for ineligibility)
- **M-N:** Current Weight vs New Weight

Column widths and formatting are precisely defined (lines 493-507).

### Chain ID Mapping

The script maps Stride's `host_zone.chain_id` values to cosmos.directory network names via `CHAIN_ID_TO_NETWORK` (lines 28-51). Special cases:
- Bandchain: only `laozi-mainnet` supported
- Saga: supports both `saga-1` and `ssc-1`

### CEX Detection

Known centralized exchange validators are filtered using moniker pattern matching in `isCexMoniker()` (lines 974-997). Patterns include binance, coinbase, kraken, okx, kucoin, etc.

## Development Workflow

### Testing in Google Apps Script Editor

1. Open the Google Spreadsheet
2. Go to **Extensions > Apps Script**
3. Make changes to `stride-delegations.gs`
4. Save (Cmd/Ctrl+S)
5. Run functions directly from the editor for testing
6. Use `Logger.log()` for debugging; view logs via **View > Logs**

### Deploying Changes

After testing in the script editor:

1. Copy the updated code from the editor
2. Paste it into `stride-delegations.gs` in this repo
3. Commit and push to GitHub

**Note:** There is no automated sync between GitHub and the Google Spreadsheet. Changes must be manually copied both ways.

### Menu Functions

The script adds a custom "Stride" menu to the spreadsheet with two functions:

1. **Refresh host_zones + live data** → `refreshStrideHostZones()`
   - Full data refresh for all chains
   - Deletes and recreates all chain sheets
   - Run this first

2. **Apply flagship eligibility (gov + uptime)** → `applyFlagshipEligibilityForActiveSheet()`
   - Only works on flagship chain sheets (cosmoshub-4, osmosis-1, celestia, dydx-mainnet-1)
   - Must be run AFTER ensuring uptime/governance data is populated in respective sheets
   - Updates eligibility, reasons, and weights columns

### Supporting Sheets

Flagship chains expect additional sheets with uptime and governance data:

- `cosmos-uptime+governance`
- `osmosis-uptime+governance`
- `celestia-uptime+governance`
- `dydx-uptime+governance`

These sheets must have:
- Column A: Validator Name
- Column B: Governance participation (as fraction like "5/10" or decimal)
- Column C: Uptime percentage (as fraction or percentage)

The main sheets use VLOOKUP formulas (lines 356-384) to pull this data.

## Code Organization

- **Lines 1-75:** Constants and configuration
- **Lines 77-94:** Menu setup (`onOpen`)
- **Lines 96-126:** Main refresh entry point
- **Lines 128-512:** Core sheet creation with universal eligibility
- **Lines 514-925:** Flagship eligibility application (manual step)
- **Lines 927-968:** Live validator data fetching from cosmos.directory
- **Lines 970-997:** CEX detection
- **Lines 999-1126:** Validator data merging logic
- **Lines 1128-1251:** Capped proportional weight algorithm
- **Lines 1253-1318:** Formatting and utility helpers

## Important Constraints

1. **No automated deployment:** Code must be manually copied to/from Google Apps Script editor
2. **API rate limits:** cosmos.directory and Polkachu APIs may rate limit; script uses `muteHttpExceptions` for graceful handling
3. **Governance data:** Cannot be queried on-chain (proposals are pruned from state); requires manual input or indexer
4. **Uptime data:** No native on-chain uptime query; requires external monitoring/indexer
5. **32-validator cap:** Enforced to optimize relaying costs by limiting number of active delegations
6. **VLOOKUP dependencies:** Flagship eligibility requires correctly formatted supporting sheets

## Governance Context

This implementation follows a Stride governance proposal for standardized delegations. Any changes to:
- Eligibility criteria thresholds
- Weight cap percentage (currently 9%)
- Flagship chain list
- CEX validator patterns

...should be approved through Stride governance before implementation.

## File Structure

```
stride-delegations/
├── README.md                 # User-facing documentation
├── stride-delegations.gs     # Main Google Apps Script code
├── .gitignore               # Standard ignores
└── CLAUDE.md                # This file
```
