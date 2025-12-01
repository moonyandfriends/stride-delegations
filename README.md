# Stride Delegations - Google Apps Script

## Governance Proposal: Standardize Stride's Delegation Methodology

This repository contains the implementation of a Stride governance proposal to **standardize Stride's delegation methodology across all host chains** where Stride provides liquid staking services.

### Background

Stride provides liquid staking services for multiple Cosmos chains, managing delegations of liquid staked tokens to validators on each host chain. Historically, delegation strategies have differed by chain—some using copy-staking models, others relying on council-selected validators or other criteria. These variations have led to:

- **Increased operational complexity** managing different approaches per chain
- **Higher costs** particularly in relaying fees as validator sets expand
- **Inconsistent delegation philosophies** across the Stride ecosystem

This proposal implements a **uniform delegation strategy for all host chains**, addressing these challenges while optimizing for cost efficiency and operational simplicity.

### Goals

1. **Standardization**: Single, objective delegation methodology across all Stride-supported chains
2. **Cost reduction**: Minimize relaying costs by capping the number of delegations per chain
3. **Decentralization**: Distribute stake across qualifying validators using proportional allocation
4. **Automation**: Where possible, use on-chain data to eliminate manual intervention
5. **Scalability**: Dynamic criteria that adapt to different validator set sizes

## Overview

This Google Apps Script automates the calculation and management of Stride's standardized delegation methodology. It:

- Fetches live validator data from multiple chains via APIs
- Applies objective eligibility criteria automatically
- Distributes delegations proportionally using a capped "water-filling" algorithm
- Limits delegations to 32 validators per chain to optimize relaying costs
- Ensures no validator receives more than 9% of Stride's stake (dynamic cap)

## Live Spreadsheet

Current delegation weights can be viewed here:
https://docs.google.com/spreadsheets/d/1-CIvqQXiip-IMAf_DF3hTaVyjfWXbIBsbmCdplIvDYE/edit?usp=sharing

## Delegation Methodology

Delegations are distributed according to each validator's stake weight among the set of qualifying validators, using a **capped proportional ("water-filling") method** to ensure no validator receives more than 9% of Stride's stake on that chain.

### Universal Eligibility Criteria (All Host Chains)

These criteria are applied to **all host chains** and use only on-chain data for full automation:

1. **Active status**: Validator must be in bonded status (`BOND_STATUS_BONDED`)
2. **No CEX validators**: Exclude known centralized exchange validators (detected by moniker matching)
3. **Commission ≤ 10%**: Commission rate must be 10% or lower
4. **Not in bottom 5%**: Exclude validators in the bottom 5% of the active set by stake¹
5. **Dynamic top-exclusions**: Exclude top validators based on active set size to promote downward redistribution:
   - **64+ validators** → exclude top 8 by stake¹
   - **98+ validators** → exclude top 12 by stake¹
   - **132+ validators** → exclude top 16 by stake¹
6. **32-validator cap per chain**: Among validators meeting above criteria, limit to the top 32 by stake weight¹

¹ **Critical**: All stake measurements exclude Stride's current delegations to prevent circular reinforcement of existing positions. This is calculated as: `Live Delegations - Stride Delegations`

### Additional Criteria (Flagship Chains Only)

The following chains have **additional requirements** due to their significant TVL in Stride and the availability of reliable off-chain data:

- **Cosmos Hub** (cosmoshub-4)
- **Osmosis** (osmosis-1)
- **Celestia** (celestia)
- **dYdX** (dydx-mainnet-1)

**Additional requirements for flagship chains:**

7. **Governance participation**:
   - **Cosmos Hub, Osmosis, dYdX**: Must have voted on at least **5 of the 10** most recent governance proposals
   - **Celestia**: Must have voted on at least **2 of the 5** most recent governance proposals
   - If governance has not had 10 proposals, the threshold adjusts (e.g., 2 of 5 most recent)

8. **Uptime / Sign time ≥ 95%**: Average signing time must be at least 95% over the past 30 days

**Why only flagship chains?**
These criteria require off-chain data that cannot be queried directly from nodes:
- Proposals are pruned from state after the voting period ends
- There is no native uptime query available on-chain

A reliable indexer is needed to track this data, and manual intervention may be required. Due to these constraints, stricter requirements are only applied to flagship chains with significant TVL in Stride.

## Distribution Method: Capped Proportional ("Water-Filling") Algorithm

Among all qualifying validators, delegations are distributed according to each validator's stake weight using a **capped proportional allocation** approach:

### How It Works

1. **Proportional baseline**: Start by distributing weight proportional to each eligible validator's stake (excluding Stride's current delegations)
2. **Apply cap**: If any validator would receive more than 9% of total Stride stake, cap them at 9%
3. **Redistribute overflow**: Take the excess weight from capped validators and redistribute it proportionally among uncapped validators
4. **Repeat**: Continue the process until all validators are either capped or there's no remaining weight to distribute
5. **Small validator sets**: If there are fewer than 12 eligible validators with positive stake, the cap is not applied (simple proportional distribution)

### Dynamic Cap Formula

The per-validator cap varies based on the number of eligible validators to ensure feasible allocation:

```
softCap(N) = 8% × (32 / N)^0.5
finalCap(N) = max(softCap(N), 1/N)
```

Where `N` is the number of eligible validators. This ensures:
- **Larger sets**: More redistribution (cap approaches 8%)
- **Smaller sets**: Higher caps to allow full allocation
- **Mathematical feasibility**: Cap never goes below 1/N, ensuring 100% allocation is always possible

This "water-filling" metaphor describes how delegation weight "fills up" validators until they hit their cap, then "overflows" to the next validator.

### Benefits

- **Prevents over-concentration**: No single validator gets too much Stride stake
- **Maintains proportionality**: Larger validators still receive more, just not excessively
- **Decentralizes stake**: Encourages distribution across multiple validators
- **Scales dynamically**: Adapts to different validator set sizes

### Implementation

The algorithm is implemented in `computeCappedWeights()` and `computeDynamicCapFraction()` functions (lines 136-213 in stride-delegations.gs).

## Rebalancing Schedule

- **Quarterly rebalancing** to reflect changes in validator stake weights and eligibility
- **Initial rebalancing**: Q1 2025 (proposal is currently in Q4 2024)
- **Process**: At each rebalance, validator eligibility is re-evaluated and new weights are computed
- **Changes**: Validators meeting criteria receive proportional delegations; ineligible validators have delegations reduced or removed

## Special Cases & Limitations

### Dymension and Celestia (Multisig-Handled)

This standardized methodology covers **delegations and quarterly rebalancing** only. It does NOT currently cover:

- **Redelegations** on Dymension (e.g., for slashing avoidance)
- **Redelegations** on the current multisig-handled Celestia liquid staking

These are currently managed via multisig and will be moved to this automated program once both chains are fully handled by ICA/ICQ.

**Note**: Stride's **ICA/ICQ-handled Celestia** liquid staking is fully covered by this proposal.

### Intent for Full Coverage

The long-term intention is to move all chains entirely to this standardized program after redelegation mechanisms are migrated from multisig to ICA control.

## Governance Voting Options

This proposal requires Stride governance approval. Voting options:

- **YES** – You agree that Stride should standardize its delegation methodology across all host chains as outlined in this proposal.

- **NO** – You disagree that Stride should standardize its delegation methodology across all host chains as outlined in this proposal.

- **NO WITH VETO** – A NoWithVeto vote indicates that the proposal either:
  1. Is deemed to be spam or irrelevant to Stride
  2. Disproportionately infringes on minority interests
  3. Violates or encourages violation of the rules of engagement as currently set out by Stride governance

  If NoWithVeto votes exceed one-third of total votes, the proposal is rejected and the deposit is burned.

- **ABSTAIN** – You wish to contribute to quorum but formally decline to vote either for or against the proposal.

## Rationale & Final Thoughts

This standardization advances Stride's objectives of efficient and cost-effective liquid staking. By unifying the delegation process, Stride can:

- **Minimize operational overhead**: Single methodology eliminates chain-specific logic and maintenance
- **Reduce relaying costs**: 32-validator cap per chain controls transaction fees
- **Improve transparency**: Objective, automated criteria eliminate subjective decisions
- **Enhance scalability**: Dynamic criteria adapt automatically as validator sets grow or shrink

Stride governance retains authority to refine criteria or schedules through future proposals when necessary. Transparency is maintained through the public spreadsheet and this open-source implementation.

---

## Implementation Details

This Google Apps Script implementation provides a transparent, auditable calculation of Stride's delegations. The code is open-source and runs directly within a Google Spreadsheet.

### Data Sources

The script combines data from multiple sources:

1. **Stride delegations**: Fetched from Polkachu API
   - Endpoint: `https://stride-api.polkachu.com/Stride-Labs/stride/stakeibc/host_zone`
   - Provides current Stride delegations to each validator on each chain

2. **Live validator data**: Fetched from cosmos.directory REST endpoints
   - Endpoint format: `https://rest.cosmos.directory/{network}/cosmos/staking/v1beta1/validators`
   - Provides validator status, commission, total stake, and metadata
   - Pagination limit: 1000 validators per chain

3. **Uptime and governance data (flagship chains only)**: Manually entered from SmartStake analytics
   - Source: https://analytics.smartstake.io
   - Required for Cosmos Hub, Osmosis, Celestia, and dYdX
   - Cannot be automated due to lack of on-chain queries for historical proposal votes and uptime metrics

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

## Governance & Authority

This implementation is the reference code for a Stride governance proposal to standardize delegations across all host chains. The proposal specifies:

- Eligibility criteria for all chains
- The capped proportional allocation algorithm
- The quarterly rebalancing schedule
- Special handling for flagship chains

**Any modifications to the delegation methodology require Stride governance approval through a new proposal.**

The spreadsheet linked above serves as:
1. **Transparency tool**: Public visibility into current and proposed delegations
2. **Calculation engine**: Automated computation of eligibility and weights
3. **Audit trail**: Historical record of delegation decisions

## Repository Structure

This repository contains the complete implementation:

```
stride-delegations/
├── README.md                 # This file - comprehensive governance context and user documentation
├── CLAUDE.md                 # Technical guide for Claude Code assistant (architecture, code organization)
├── stride-delegations.gs     # Main Google Apps Script implementation (1,284 lines)
└── .gitignore               # Standard Git ignores
```

**Deployment**: Code must be manually copied to/from the Google Apps Script editor in the spreadsheet. There is no automated sync between this GitHub repository and the live spreadsheet.

**Development workflow**:
1. Make changes in Google Apps Script editor (Extensions > Apps Script)
2. Test thoroughly using the script's menu functions
3. Copy updated code back to this repository
4. Commit and push to GitHub for version control and transparency

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

### Governance Changes

Changes to the **delegation methodology** (eligibility criteria, weight caps, rebalancing frequency, etc.) must be approved through Stride governance via a new proposal. This ensures community consensus on how Stride's liquid staking delegations are managed.

### Technical Improvements

Technical improvements and bug fixes that don't change the methodology can be submitted via pull request:

- Performance optimizations
- Code refactoring for maintainability
- Bug fixes in data fetching or calculations
- Improved error handling
- Documentation updates

**Important**: Ensure all changes are tested in the Google Apps Script editor before submitting a PR. Include before/after screenshots or validation data demonstrating correct behavior.

### Support & Questions

- **Issues**: Open an issue in this repository for bugs or feature requests
- **Stride Community**: Discuss governance-related questions in Stride's official channels
- **Contact**: Reach out to Stride Labs for urgent matters

## License & Disclaimer

This code is provided as-is for transparency and community review. Use at your own risk. The delegation methodology is subject to Stride governance decisions.

## Additional Resources

- **Live Spreadsheet**: [View current delegations](https://docs.google.com/spreadsheets/d/1-CIvqQXiip-IMAf_DF3hTaVyjfWXbIBsbmCdplIvDYE/edit?usp=sharing)
- **Stride Protocol**: [Website](https://stride.zone) | [Docs](https://docs.stride.zone)
- **cosmos.directory**: [Validator data source](https://cosmos.directory)
- **SmartStake Analytics**: [Uptime & governance data](https://analytics.smartstake.io)
- **Polkachu**: [Stride API provider](https://polkachu.com)

---

**This implementation demonstrates Stride's commitment to transparent, objective, and automated delegation management across the Cosmos ecosystem.**
