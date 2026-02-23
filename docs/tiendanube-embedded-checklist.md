# Checklist de embedded para Tiendanube (Panel HarujaGdl)

Dominio oficial del iframe: `https://paneltb.harujagdl.com`.

## Configuración en Tiendanube Partners
- Página de la aplicación: `https://paneltb.harujagdl.com`
- URL para redirigir después de la instalación: `https://us-central1-haruja-tiendanube.cloudfunctions.net/tnAuthCallback`

Después de guardar cambios, reinstalar la app en la tienda para forzar refresco de permisos/allowlist.

## Firebase Authentication
Agregar en **Authorized domains**:
- `paneltb.harujagdl.com`
- `haruja-tiendanube.web.app`
- `haruja-tiendanube.firebaseapp.com`

## Validación rápida
1. Abrir la app desde Admin Tiendanube.
2. Verificar que no aparezcan errores de dominio OAuth, CSP o permisos Firestore.
3. Confirmar que listado y acciones admin funcionen tras login.
