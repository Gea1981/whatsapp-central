import { createContext } from 'react';
import type { RoleContextType } from '../types/role';

export const RoleContext = createContext<RoleContextType | undefined>(undefined);
