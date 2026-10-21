# routes — blocked 2026-10-21

Shared route pass not started: it needs live page fetches to find course maps and start coordinates. In this session the egress proxy returned 403 to CONNECT for runera.mx and chronostart.com.mx and DNS failed (ENOTFOUND) for tritour.org, asdeporte.com, finishers.com and others, so WebFetch could not load any page. WebSearch snippets are not fetched sources under the anti-hallucination contract, so no data was changed. races.json is untouched. Re-run once those hosts are allowed.
