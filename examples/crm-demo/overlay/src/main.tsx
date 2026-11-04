import { createRoot } from 'react-dom/client';
import { Customize } from '@forkui/react';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(<><App /><Customize /></>);
