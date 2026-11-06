let appContainer = null;
let routeMap = {};

export function navigate(route) {
  const target = `#${route}`;
  if (window.location.hash === target) {
    renderCurrentRoute();
  } else {
    window.location.hash = route;
  }
}

function renderCurrentRoute() {
  const raw = window.location.hash.slice(1).replace(/^\/+/, '');
  const name = raw.split('?')[0] || 'home';
  const render = routeMap[name] ?? routeMap.home;
  render(appContainer);
  window.scrollTo(0, 0);
}

export function startRouter(container, routes) {
  appContainer = container;
  routeMap = routes;
  window.addEventListener('hashchange', renderCurrentRoute);
  renderCurrentRoute();
}
