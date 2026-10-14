#!/bin/sh
# Agent Gateway re-encrypts the agents' outbound TLS with its own root CA (AGENT_GATEWAY_CA, PEM,
# set by platform/runtime.py when the agents are bound to a gateway). Node trusts it in addition
# to its built-in roots.
if [ -n "$AGENT_GATEWAY_CA" ]; then
  printf '%s\n' "$AGENT_GATEWAY_CA" > /tmp/agent-gateway-ca.pem
  export NODE_EXTRA_CA_CERTS=/tmp/agent-gateway-ca.pem
fi
exec node main.js
