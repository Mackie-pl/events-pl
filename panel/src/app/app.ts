import { Component, inject } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { TuiButton, TuiIcon, TuiRoot } from '@taiga-ui/core';

import { DataService } from './data';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, TuiRoot, TuiButton, TuiIcon],
  templateUrl: './app.html',
  styleUrl: './app.less',
})
export class App {
  protected readonly data = inject(DataService);
}
