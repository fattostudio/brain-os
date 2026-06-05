import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import Desktop from './components/Desktop.jsx';

// NOTE: deliberately NOT wrapping in <React.StrictMode>. StrictMode double-
// invokes effects in dev, which would start the ribbon engine twice over the
// same SVG and make the weave glitch/double. The original standalone HTML ran
// its startup exactly once — this matches that.
createRoot(document.getElementById('root')).render(<Desktop />);
