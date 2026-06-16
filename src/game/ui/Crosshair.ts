export class Crosshair {
  public readonly element: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.element = document.createElement('div');
    this.element.className = 'crosshair';
    parent.appendChild(this.element);
  }
}
