// When is a pathofexile.com login confirmed? Only when the site itself shows a signed-in page.
// Loading /login with a real session redirects straight to the account; without one the site
// stays on /login (or bounces through Steam). A POESESSID cookie proves nothing: the site hands
// one to anonymous visitors too, which is how Connect used to "succeed" while logged out.
const loginConfirmedAt = (url) => {
  let u
  try { u = new URL(String(url)) } catch { return false }
  if (u.protocol !== 'https:' || !/(^|\.)pathofexile\.com$/i.test(u.hostname)) return false
  return !/^\/(login|logout)(\/|$)/i.test(u.pathname)
}

// Evaluated in the login window on a page worth probing: a pathofexile.com page is signed in when it offers to log
// out, or says who is logged in (the trade site's header). Reads the page only; never a cookie, never a form.
const SIGNED_IN_PROBE = "!!(document.querySelector('a[href*=\"/logout\"]') || /Logged in as/i.test(document.body && document.body.innerText || ''))"
// The page is probed when its DOM is ready and then this often until it is signed in (a login finishes with a
// redirect, a Steam hop, or an in-page change; one probe at navigation time ran before the DOM existed).
const LOGIN_POLL_MS = 1200

module.exports = { loginConfirmedAt, SIGNED_IN_PROBE, LOGIN_POLL_MS }
