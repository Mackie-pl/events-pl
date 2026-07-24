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
  { path: '**', redirectTo: '' },
];
