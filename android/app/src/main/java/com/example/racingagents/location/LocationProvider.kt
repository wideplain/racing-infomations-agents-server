package com.example.racingagents.location

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.CancellationSignal
import androidx.core.content.ContextCompat
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/** A single lat/lng fix for attaching weather to an AI解析 request — not for navigation, so no
 * accuracy/bearing/speed fields. */
data class LocationFix(val lat: Double, val lng: Double)

/** Where this app's pit is, for the server's weather lookup (see the server's
 * resolveWeatherLocation, which already falls back to this the same way it falls back to the
 * viewer's browser-reported pit location). Unlike the driver screen this app doesn't track a
 * moving car, so one fresh fix via FUSED_PROVIDER is enough — no continuous updates, and no
 * Play Services dependency (FUSED_PROVIDER has been part of the platform since API 31, this
 * app's minSdk). */
class LocationProvider(private val context: Context) {
    private val locationManager: LocationManager? by lazy {
        ContextCompat.getSystemService(context, LocationManager::class.java)
    }

    private fun hasPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    /** Null when permission is missing, no provider is enabled, or nothing arrives before the
     * caller's own timeout cancels this — callers must treat that exactly like the server does
     * when no location has been posted at all: proceed without one. */
    suspend fun getCurrentLocation(): LocationFix? {
        val manager = locationManager ?: return null
        if (!hasPermission()) return null
        if (!manager.isProviderEnabled(LocationManager.FUSED_PROVIDER)) return null

        return suspendCancellableCoroutine { cont ->
            val signal = CancellationSignal()
            cont.invokeOnCancellation { signal.cancel() }
            try {
                manager.getCurrentLocation(
                    LocationManager.FUSED_PROVIDER,
                    signal,
                    context.mainExecutor,
                ) { location ->
                    if (cont.isActive) {
                        cont.resume(location?.let { LocationFix(it.latitude, it.longitude) })
                    }
                }
            } catch (e: SecurityException) {
                if (cont.isActive) cont.resume(null)
            }
        }
    }
}
