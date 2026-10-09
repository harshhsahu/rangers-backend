/**
 * Test-only preload (node --import). Third-party hosts that the integrations call by
 * hardcoded URL are rerouted to the fake upstream, so a test run never reaches the
 * real Telegram, EasyCron or Discord REST APIs.
 *
 *   https://api.telegram.org/bot123/sendMessage → $FAKE_UPSTREAM_URL/__ext/api.telegram.org/bot123/sendMessage
 */
const fake = process.env.FAKE_UPSTREAM_URL;
const REROUTED_HOSTS = new Set(['api.telegram.org', 'www.easycron.com', 'discord.com']);

if (fake) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (REROUTED_HOSTS.has(url.host)) {
      const rerouted = `${fake}/__ext/${url.host}${url.pathname}${url.search}`;
      return realFetch(input instanceof Request ? new Request(rerouted, input) : rerouted, init);
    }
    return realFetch(input, init);
  };
}
