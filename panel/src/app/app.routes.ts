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
    path: 'discovery',
    title: 'Discovery · events-pl',
    loadComponent: () => import('./pages/discovery/discovery').then((m) => m.DiscoveryPage),
  },
  {
    path: 'discovery/:runId',
    title: 'Discover run · events-pl',
    loadComponent: () => import('./pages/discover-run/discover-run').then((m) => m.DiscoverRunPage),
  },
  { path: '**', redirectTo: '' },
];
