#!/usr/bin/env bash
# Create or update funx-router (SCF Web function, ap-hongkong, tagged codename=funx,
# NO role, NO VPC) and give it the function URL that SCF custom domains require.
# PREPARED, NOT RUN. Needs STS creds of <deploy-role> + a whitelisted FUNX_DEPLOY_KEY.
set -euo pipefail
cd "$(dirname "$0")/.."
npm test
node cli/funx.js router-deploy
