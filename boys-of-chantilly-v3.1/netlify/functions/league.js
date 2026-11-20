// Netlify Function — deployed at /.netlify/functions/league,
// exposed at /api/league via the redirect in netlify.toml.
//
// Runs server-side, attaches your ESPN cookies, and fetches league
// data from ESPN's API, so the browser never needs direct
// cross-origin access to fantasy.espn.com and your cookies never
// ship in client-side JS.
//
// Reads these environment variables (already set on this Netlify
// site): ESPN_S2, ESPN_SWID, ESPN_LEAGUE_ID, ESPN_SEASON

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const leagueId = params.league || process.env.ESPN_LEAGUE_ID || '353576';
  const season = params.season || process.env.ESPN_SEASON || '2026';
  const espnS2 = process.env.ESPN_S2;
  const swid = process.env.ESPN_SWID;

  if (!espnS2 || !swid) {
    return json(500, {
      error: 'missing_credentials',
      message:
        'ESPN_S2 and ESPN_SWID environment variables are not set on this site. Add them in Netlify > Site configuration > Environment variables, then trigger a new deploy.',
    });
  }

  const views = ['mTeam', 'mRoster', 'mMatchupScore', 'mStandings', 'mSettings', 'mTransactions2'];
  const qs = views.map((v) => `view=${v}`).join('&');
   const espnUrl = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?${qs}`;

  try {
    const resp = await fetch(espnUrl, {
      headers: {
        Cookie: `espn_s2=${espnS2}; SWID=${swid}`,
        'User-Agent': 'Mozilla/5.0 (dashboard proxy)',
        Accept: 'application/json',
      },
    });

    const bodyText = await resp.text();

    if (!resp.ok) {
      return json(resp.status, {
        error: 'espn_error',
        status: resp.status,
        message:
          resp.status === 401 || resp.status === 403
            ? 'ESPN rejected the credentials. The espn_s2/SWID cookies may be stale — re-copy them from a fresh, logged-in browser session and update the env vars.'
            : `ESPN returned HTTP ${resp.status}.`,
        detail: bodyText.slice(0, 800),
      });
    }

    let data;
    try {
      data = JSON.parse(bodyText);
    } catch (e) {
      return json(502, { error: 'bad_json', message: 'ESPN response was not valid JSON.', detail: bodyText.slice(0, 800) });
    }

    return json(200, data);
  } catch (err) {
    return json(500, { error: 'fetch_failed', message: String(err) });
  }
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(obj),
  };
}
