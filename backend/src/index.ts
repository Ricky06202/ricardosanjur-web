import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Resend } from 'resend'

const resend = new Resend('re_WzDFGRN6_G2Uo4uygxbeqvmy4QF3P4j5y')

const app = new Hono()

app.get('/', (c) => {
  return c.text('API - Topografía Especializada S.A.')
})

app.post('/api/contact', async (c) => {
  try {
    const body = await c.req.json()
    const { nombre, email, telefono, tema, mensaje } = body

    if (!nombre || !email || !tema || !mensaje) {
      return c.json({ error: 'Faltan campos requeridos' }, 400)
    }

    await resend.emails.send({
      from: 'Contacto Web <onboarding@resend.dev>',
      to: ['gerencia@ricardosanjur.com'],
      subject: `Nuevo mensaje: ${tema} - de ${nombre}`,
      html: `
        <h2>Nuevo mensaje de contacto</h2>
        <p><strong>Nombre:</strong> ${nombre}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Teléfono:</strong> ${telefono || 'No proporcionado'}</p>
        <p><strong>Tema:</strong> ${tema}</p>
        <p><strong>Mensaje:</strong></p>
        <p>${mensaje}</p>
      `
    })

    return c.json({ success: true, message: 'Mensaje enviado correctamente' })
  } catch (error) {
    console.error('Error al enviar email:', error)
    return c.json({ error: 'Error al enviar el mensaje' }, 500)
  }
})

app.post('/api/quote', async (c) => {
  try {
    const body = await c.req.json()
    const { nombre, empresa, email, telefono, direccion, numeroFinca, area, tipoServicio, caracteristicaFinca, mensaje } = body

    if (!nombre || !email || !telefono || !direccion || !numeroFinca) {
      return c.json({ error: 'Faltan campos requeridos' }, 400)
    }

    const servicios = Array.isArray(tipoServicio) ? tipoServicio.join(', ') : tipoServicio || 'No especificado'
    const caracteristicas = Array.isArray(caracteristicaFinca) ? caracteristicaFinca.join(', ') : caracteristicaFinca || 'No especificado'

    await resend.emails.send({
      from: 'Cotización Web <onboarding@resend.dev>',
      to: ['gerencia@ricardosanjur.com'],
      subject: `Solicitud de Cotización - ${nombre} - Finca #${numeroFinca}`,
      html: `
        <h2>Nueva Solicitud de Cotización</h2>
        
        <h3>Datos Personales</h3>
        <p><strong>Nombre:</strong> ${nombre}</p>
        <p><strong>Empresa:</strong> ${empresa || 'No especificada'}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Teléfono:</strong> ${telefono}</p>
        
        <h3>Datos de la Finca</h3>
        <p><strong>Dirección:</strong> ${direccion}</p>
        <p><strong>Número de Finca:</strong> ${numeroFinca}</p>
        <p><strong>Área:</strong> ${area || 'No especificada'}</p>
        
        <h3>Servicios Requeridos</h3>
        <p>${servicios}</p>
        
        <h3>Características de la Finca</h3>
        <p>${caracteristicas}</p>
        
        <h3>Mensaje Adicional</h3>
        <p>${mensaje || 'Sin mensaje adicional'}</p>
      `
    })

    return c.json({ success: true, message: 'Solicitud enviada correctamente' })
  } catch (error) {
    console.error('Error al enviar email:', error)
    return c.json({ error: 'Error al enviar la solicitud' }, 500)
  }
})

serve({
  fetch: app.fetch,
  port: 3000
}, (info) => {
  console.log(`Server running on http://localhost:${info.port}`)
})
