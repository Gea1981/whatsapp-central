import { useContext } from 'react';
import { RoleContext } from './roleContext';
import type { RoleContextType } from '../types/role';

export type { UserRole, RoleContextType } from '../types/role';

export function useRole(): RoleContextType {
  const context = useContext(RoleContext);
  if (context === undefined) {
    throw new Error('useRole must be used within a RoleProvider');
  }
  return context;
}
