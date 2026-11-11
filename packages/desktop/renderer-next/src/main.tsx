import { render } from 'preact';
import '../../renderer/styles.css';
import './shell.css';
import { Shell } from './Shell';

if (navigator.userAgent.includes('Electron')) document.body.classList.add('is-electron');

render(<Shell />, document.getElementById('root')!);
