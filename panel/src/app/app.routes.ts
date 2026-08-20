import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    title: 'events-pl · observability',
    loadComponent: () => import('./pages/overview/overview').then((m) => m.OverviewPage),
  },
  {
    path: 'run/:runId',
    title: 'Run · events-pl',
    loadComponent: () => import('./pages/run/run').then((m) => m.RunPage),
  },
  {
    path: 'run/:runId/source/:sourceId',
    title: 'Source · events-pl',
    loadComponent: () => import('./pages/source/source').then((m) => m.SourcePage),
  },
  {
    // źródło w skali dłuższej niż jeden przebieg — historia statusów + wszystko, co ma
    // dziś w rejestrze. Bez runId w adresie, bo pytanie nie dotyczy żadnego jednego dnia.
    path: 'source/:sourceId',
    title: 'Źródło · events-pl',
    loadComponent: () =>
      import('./pages/source-history/source-history').then((m) => m.SourceHistoryPage),
  },
  {
    path: 'costs',
    title: 'Pieniądze · events-pl',
    loadComponent: () => import('./pages/costs/costs').then((m) => m.CostsPage),
  },
  {
    path: 'reuse',
    title: 'Powtarzalność · events-pl',
    loadComponent: () => import('./pages/reuse/reuse').then((m) => m.ReusePage),
  },
  {
    path: 'yield',
    title: 'Plon · events-pl',
    loadComponent: () => import('./pages/yield/yield').then((m) => m.YieldPage),
  },
  {
    path: 'blocks',
    title: 'Jałowe bloki · events-pl',
    loadComponent: () => import('./pages/blocks/blocks').then((m) => m.BlocksPage),
  },
  {
    path: 'discovery',
    title: 'Discovery · events-pl',
    loadComponent: () => import('./pages/discovery/discovery').then((m) => m.DiscoveryPage),
  },
  {
    path: 'discovery/:runId',
    title: 'Discover run · events-pl',
    loadComponent: () => import('./pages/discover-run/discover-run').then((m) => m.DiscoverRunPage),
  },
  {
    path: 'config',
    title: 'Konfiguracja · events-pl',
    loadComponent: () => import('./pages/config/config').then((m) => m.ConfigPage),
  },
  { path: '**', redirectTo: '' },
];
