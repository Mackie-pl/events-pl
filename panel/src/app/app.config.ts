import { provideHttpClient, withFetch } from '@angular/common/http';
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideTaiga } from '@taiga-ui/core';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withFetch()),
    // Ścieżki bez `#`. Na GitHub Pages działa to tylko dlatego, że deploy kopiuje
    // index.html na panel/404.html — Pages oddaje go dla każdej nieistniejącej ścieżki
    // i router czyta prawdziwy URL. Skasujesz tamten krok → deep linki przestaną działać.
    provideRouter(routes, withComponentInputBinding()),
    provideTaiga(),
  ],
};
